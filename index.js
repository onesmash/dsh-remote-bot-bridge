// dsh-remote-bot-bridge
//
// Bot-to-bot messaging over ds-harness-remote, without taking over this
// machine's Harness window.
//
// ds-harness-remote carries an end-to-end encrypted, NAT-traversing channel to
// another device, and its `plugin.route.v1` capability forwards ds-bot's POST
// api/bot operations over that channel. The remote plugin publishes its
// `ClientModeRuntime` instance as the cordis service `dshRemoteClient`; the
// instance's `connect(deviceId)` opens a connection and returns it *without*
// touching `this.connected` or the API/gateway switches.
//
// That distinction is the whole point of this plugin. `setMode('client', id)`
// also calls `selectRemoteTarget`, which repoints this machine's whole Harness
// API at the peer — the local window becomes a view of the remote Host. Great
// for a person driving another machine, wrong for a background bot-to-bot
// message. So every call here opens a private connection with `connect()`,
// uses it, and closes it. The window never moves.
//
// No `@deepseek-ai/*` import on purpose: a profile bundle is imported before the
// installation's module hooks are guaranteed to be in place for out-of-tree
// bundles, and a static `@deepseek-ai/dsh-tools` import makes the whole bundle
// fail to load with no visible error. Tools are hand-built in the shape
// `defineTool` produces and registered through the `tools` service.

export const name = 'dsh-remote-bot-bridge'

// Do not declare module-level inject: a missing or differently-scoped service
// would keep apply() from ever running. Resolve services at runtime instead.
export const inject = []

const PREFIX = '[remote-bot-bridge]'

// Target and aliases survive restarts so a host name is typed at most once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_PATH = join(homedir(), '.dsh', 'remote-bot-bridge.json')

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { target: null, aliases: {} }
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return {
      target: typeof parsed?.target === 'string' ? parsed.target : null,
      aliases: parsed?.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
    }
  } catch {
    return { target: null, aliases: {} }
  }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch { /* persistence is best effort; the target still works in memory */ }
}


function log(ctx, message) {
  try { ctx.logger?.info?.(`${PREFIX} ${message}`) } catch { /* logging must never throw */ }
}

function warn(ctx, message) {
  try { ctx.logger?.warn?.(`${PREFIX} ${message}`) } catch { /* ignore */ }
}

const render = (_args, value) => [{ type: 'text', text: String(value) }]

function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: { type: 'string' }, render },
    async execute(args, exec) {
      try {
        return await spec.run(args ?? {}, exec)
      } catch (error) {
        return `${spec.name} failed: ${error?.message ?? error}`
      }
    },
  }
}

export function apply(ctx, config = {}) {
  let remoteClient = null
  // Target persisted across restarts; never derived from the Remote sidebar's own
  // selection so the two cannot fight over `connected`.
  const saved = loadState()
  let targetDeviceId = saved.target
  const aliases = saved.aliases

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['dshRemoteClient'], (sub) => {
        remoteClient = sub?.dshRemoteClient ?? null
        log(ctx, `dshRemoteClient ${remoteClient === null ? 'attached (null)' : 'attached'}`)
        try {
          sub?.effect?.(() => () => { remoteClient = null }, 'remote-bot-bridge: dshRemoteClient')
        } catch { /* ignore */ }
      })
    } else {
      warn(ctx, 'ctx.inject unavailable; remote tools will report unavailable')
    }
  } catch (error) {
    warn(ctx, `inject dshRemoteClient failed: ${error?.message ?? error}`)
  }

  const api = () => {
    if (remoteClient === null) {
      throw new Error('ds-harness-remote is not available on this profile. Install it, enable it, and restart DSH.')
    }
    return remoteClient
  }

  // ---- private connection helpers -----------------------------------------

  const openPrivate = async (deviceId) => {
    const runtime = api()
    if (typeof runtime.connect !== 'function') {
      throw new Error('This ds-harness-remote build does not expose connect() on its client runtime; background delivery is unavailable.')
    }
    return runtime.connect(deviceId)
  }

  // ---- connection pool -----------------------------------------------------
  //
  // A fresh connect() costs ~5-8 s on LAN: four serial HTTPS calls
  // (listDevices, authorizeHostPeer, presenceFor, authenticate), then the
  // WebSocket + Noise handshake and ICE. The RPC itself is ~17 ms. So a
  // private connection is kept warm and reused; this is what makes bot-to-bot
  // messaging feel instant after the first call.
  //
  // There is no application-level keepalive or reconnect in the transport, so
  // a pooled connection can go stale without telling us. Rules:
  //   - one pooled connection, per target device;
  //   - idle timeout closes it so a forgotten pool does not hold a socket;
  //   - a *connect* failure may retry once (nothing was sent yet), but an RPC
  //     failure after the call was issued is never retried — that could deliver
  //     the same message twice;
  //   - the pool is closed on plugin disposal.
  const POOL_IDLE_MS = 5 * 60 * 1000

  let pool = null // { deviceId, remote, timer }

  const closePool = async (why) => {
    const current = pool
    pool = null
    if (current === null) return
    if (current.timer !== undefined) {
      try { clearTimeout(current.timer) } catch { /* ignore */ }
    }
    try { await current.remote?.client?.close?.() } catch { /* close is best effort */ }
    if (why !== undefined) log(ctx, `pool closed (${why})`)
  }

  const scheduleIdleClose = () => {
    if (pool === null) return
    if (pool.timer !== undefined) {
      try { clearTimeout(pool.timer) } catch { /* ignore */ }
    }
    pool.timer = setTimeout(() => { void closePool('idle') }, POOL_IDLE_MS)
    try { pool.timer.unref?.() } catch { /* timer may not be a Node Timers object */ }
  }

  // The Remote UI's own connection, when it is already pointed at this peer.
  // `this.connected` is kept alive by client mode, so borrowing it costs no
  // setup at all. Read-only use: plugin.route.call does not change the window's
  // target, it only rides the socket the window already owns.
  const borrowedRemote = (deviceId) => {
    try {
      const connected = api().connected
      if (connected === undefined || connected === null) return undefined
      if (connected.target?.deviceId !== deviceId) return undefined
      return connected
    } catch {
      return undefined
    }
  }

  const pooledRemote = async (deviceId) => {
    const borrowed = borrowedRemote(deviceId)
    if (borrowed !== undefined) return borrowed
    if (pool !== null && pool.deviceId === deviceId) {
      scheduleIdleClose()
      return pool.remote
    }
    await closePool('target changed')
    const remote = await openPrivate(deviceId)
    pool = { deviceId, remote, timer: undefined }
    scheduleIdleClose()
    log(ctx, `pool opened (${deviceId.slice(0, 8)}…)`)
    return remote
  }

  // Use a pooled connection for one call. `fresh` skips the pool entirely —
  // remote_ping needs that to report the honest cold cost.
  const withRemote = async (deviceId, fn, options = {}) => {
    if (options.fresh === true) {
      const remote = await openPrivate(deviceId)
      try {
        return await fn(remote)
      } finally {
        try { await remote.client?.close?.() } catch { /* close is best effort */ }
      }
    }
    let remote
    try {
      remote = await pooledRemote(deviceId)
    } catch (error) {
      // Opening the connection failed, so nothing has been sent yet. One retry
      // is safe and covers a pooled socket that died silently.
      await closePool('connect failed')
      remote = await pooledRemote(deviceId)
    }
    return fn(remote)
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { void closePool('plugin disposed') }, 'remote-bot-bridge: pool')
    }
  } catch { /* disposal hook is best effort */ }

  // Unwrap the {status, json} envelope that plugin.route.call returns.
  const unwrap = (result) => {
    if (result === null || typeof result !== 'object') {
      throw new Error('Remote returned an unexpected result.')
    }
    if (typeof result.status === 'number' && result.status !== 200) {
      throw new Error(`Host returned HTTP ${result.status}.`)
    }
    const json = result.json
    if (json === null || typeof json !== 'object') {
      throw new Error('Host returned no JSON body.')
    }
    if (json.ok !== true) {
      const message = json.error?.message ?? 'Host rejected the request.'
      const code = json.error?.code
      throw new Error(code === undefined ? message : `${message} (${code})`)
    }
    return json.value
  }

  const callBot = async (endpoint, payload) => {
    const deviceId = await ensureTarget()
    return withRemote(deviceId, async (remote) => {
      let result
      try {
        result = await remote.client.rpc('plugin.route.call', { route: 'api/bot', body: { endpoint, payload } })
      } catch (error) {
        const code = error?.code ?? ''
        if (code === 'REMOTE_NOT_CONNECTED') throw new Error('The Remote Host is not reachable right now.')
        if (code === 'FEATURE_NOT_SUPPORTED') throw new Error('The peer does not support plugin route forwarding. Update ds-harness-remote on it.')
        throw new Error(`Remote call failed: ${error?.message ?? error}`)
      }
      return unwrap(result)
    })
  }

  // ---- device directory ----------------------------------------------------

  const signedInIdentity = () => {
    try {
      return api().requireIdentity()
    } catch {
      return undefined
    }
  }

  const listDevices = async () => {
    if (signedInIdentity() === undefined) {
      throw new Error('This machine is not signed in to Remote. Sign in first (Remote sidebar), then retry.')
    }
    const server = api().server
    if (server === undefined || typeof server.listDevices !== 'function') {
      throw new Error('The Remote client runtime does not expose a device directory on this version.')
    }
    const devices = await server.listDevices()
    const rows = []
    for (const device of Array.isArray(devices) ? devices : []) {
      let online = false
      try {
        online = (await server.presenceFor(device.deviceId))?.online === true
      } catch { /* presence is best effort */ }
      rows.push({
        deviceId: device.deviceId,
        name: typeof device.name === 'string' ? device.name : device.deviceId,
        platform: device.platform,
        online,
      })
    }
    return rows
  }

  const resolveDevice = async (address) => {
    const wanted = String(address ?? '').trim()
    if (wanted === '') throw new Error('A device name or id is required.')
    const aliased = aliases[wanted.toLowerCase()]
    const devices = await listDevices()
    const device = devices.find(item => item.deviceId === (aliased ?? wanted))
      ?? devices.find(item => item.name === wanted)
      ?? devices.find(item => item.name.toLowerCase() === wanted.toLowerCase())
    if (device === undefined) {
      const names = devices.map(item => item.name).join(', ')
      throw new Error(`No device matched "${wanted}". Devices: ${names === '' ? '(none)' : names}`)
    }
    return device
  }

  // The target a send should use. No host name needed in the common case: a saved
  // target is reused, and with exactly one other online device that one is picked
  // and remembered. Only a genuine ambiguity asks the caller to choose.
  const ensureTarget = async () => {
    if (targetDeviceId !== null) {
      const devices = await listDevices()
      if (devices.some(device => device.deviceId === targetDeviceId)) return targetDeviceId
      targetDeviceId = null
    }
    // A machine registers two device ids: one for its Host role and one for its
    // Client role. Both are "this machine", so exclude either — remote's own
    // devices() only filters the Host id and would offer the Client id back.
    const selfIds = new Set()
    const clientId = signedInIdentity()?.deviceId
    if (typeof clientId === 'string') selfIds.add(clientId)
    try {
      const hostId = api().host?.hostStatus?.()?.deviceId
      if (typeof hostId === 'string') selfIds.add(hostId)
    } catch { /* host runtime may be absent */ }
    try {
      const localName = hostname()
      if (typeof localName === 'string' && localName !== '') selfIds.add(`name:${localName.toLowerCase()}`)
    } catch { /* hostname is best effort */ }
    const devices = await listDevices()
    const peers = devices.filter(device => !selfIds.has(device.deviceId)
      && !selfIds.has(`name:${String(device.name).toLowerCase()}`))
    const online = peers.filter(device => device.online)
    if (online.length === 1) {
      targetDeviceId = online[0].deviceId
      saveState({ target: targetDeviceId, aliases })
      return targetDeviceId
    }
    if (online.length === 0) {
      const names = peers.map(device => `${device.name}${device.online ? '' : ' (offline)'}`).join(', ')
      throw new Error(`No peer device is online right now. Known peers: ${names === '' ? '(none)' : names}`)
    }
    const names = online.map(device => device.name).join(', ')
    throw new Error(`Several peers are online (${names}); pick one once with remote_target and it will be remembered.`)
  }

  const listBots = async () => {
    const state = await callBot('state', null)
    const bots = Array.isArray(state?.bots) ? state.bots : []
    return bots.map(bot => ({
      id: typeof bot.sessionId === 'string' && bot.sessionId !== '' ? bot.sessionId : bot.id,
      name: typeof bot.name === 'string' && bot.name !== '' ? bot.name : bot.id,
      role: typeof bot.role === 'string' ? bot.role : undefined,
    }))
  }

  const findByAddress = (bots, address) => {
    const wanted = String(address ?? '').trim()
    if (wanted === '') throw new Error('A Bot name or id is required.')
    const exact = bots.filter(bot => bot.name === wanted || bot.id === wanted)
    if (exact.length === 1) return exact[0]
    const folded = wanted.toLowerCase()
    const loose = bots.filter(bot => bot.name.toLowerCase() === folded || bot.id.toLowerCase() === folded)
    if (loose.length === 1) return loose[0]
    if (exact.length > 1 || loose.length > 1) {
      throw new Error(`"${wanted}" matches several Bots; use the exact name or id.`)
    }
    const names = bots.map(bot => bot.name).join(', ')
    throw new Error(`No Bot named "${wanted}" on the remote Host. Available: ${names === '' ? '(none)' : names}`)
  }

  // ---- tools ---------------------------------------------------------------

  const specs = [
    tool({
      name: 'remote_status',
      description: 'Show ds-harness-remote state for this machine: sign-in, the background target this plugin talks to, and other devices on the same account with their online state and device ids. This does not change the local window.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const lines = []
        const identity = signedInIdentity()
        lines.push(identity === undefined
          ? 'signed in: no'
          : `signed in: yes (${identity.name ?? identity.deviceId ?? 'unknown device'})`)
        const localConnected = api().connected
        if (localConnected !== undefined) {
          lines.push(`window currently remote: ${localConnected.target?.name ?? localConnected.target?.deviceId} (normal Remote client mode)`)
        }
        lines.push(targetDeviceId === null
          ? 'background target: (auto — chosen on first send, or pin it with remote_target)'
          : `background target: ${targetDeviceId}`)
        const aliasNames = Object.keys(aliases)
        if (aliasNames.length > 0) lines.push(`aliases: ${aliasNames.map(name => `${name}=${aliases[name].slice(0, 8)}…`).join(', ')}`)
        const devices = await listDevices()
        lines.push(`devices on this account: ${devices.length}`)
        for (const device of devices) {
          const mark = device.deviceId === targetDeviceId ? ' <- background target' : ''
          lines.push(`  - ${device.name} | ${device.deviceId} | ${device.platform ?? '?'} | ${device.online ? 'online' : 'offline'}${mark}`)
        }
        return lines.join('\n')
      },
    }),
    tool({
      name: 'remote_target',
      description: 'Optionally choose which device this machine sends Bot messages to. Usually unnecessary: the target is remembered across restarts, and when exactly one peer is online it is picked automatically. Only call this to pin a specific device or to change it. Pass "none" to clear. Only sets a target — it does not connect or switch the local window.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string', description: 'Device name, device id, or a saved alias from remote_status, or "none" to clear the target.' },
          alias: { type: 'string', description: 'Optional short alias to save for this device, e.g. "home"; later remote_target device="home" resolves it.' },
        },
        required: ['device'],
        additionalProperties: false,
      },
      async run(args) {
        const wanted = String(args?.device ?? '').trim()
        if (wanted === '') throw new Error('a device name or id is required.')
        if (wanted.toLowerCase() === 'none') {
          targetDeviceId = null
          saveState({ target: null, aliases })
          return 'Background target cleared.'
        }
        const device = await resolveDevice(wanted)
        targetDeviceId = device.deviceId
        const alias = String(args?.alias ?? '').trim().toLowerCase()
        if (alias !== '') aliases[alias] = device.deviceId
        saveState({ target: targetDeviceId, aliases })
        const saved = alias === '' ? '' : ` Saved alias "${alias}".`
        return `Background target set to ${device.name} (${device.deviceId}), ${device.online ? 'online' : 'offline'}. Remembered across restarts.${saved}`
      },
    }),
    tool({
      name: 'remote_bots',
      description: 'List the Bots on the background target device. Opens a private connection for the call and closes it afterwards; the local window is not affected.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const bots = await listBots()
        if (bots.length === 0) return 'The remote device reports no Bots.'
        return bots
          .map(bot => `${bot.name}${bot.role === undefined ? '' : ` (${bot.role})`} — ${bot.id}`)
          .join('\n')
      },
    }),
    tool({
      name: 'remote_send',
      description: 'Send a message to a Bot on the background target device. The message arrives in that Bot\'s conversation as user input, as if its owner had typed it. Opens a private connection for the call and closes it afterwards; the local window is not affected. Use remote_bots first to learn the names.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Name or session id of the Bot on the remote device.' },
          message: { type: 'string', description: 'The message text to deliver.' },
        },
        required: ['to', 'message'],
        additionalProperties: false,
      },
      async run(args) {
        const body = String(args?.message ?? '')
        if (body.trim() === '') throw new Error('the message is empty.')
        const bots = await listBots()
        const found = findByAddress(bots, args?.to)
        await callBot('send', { sessionId: found.id, text: body })
        return `Delivered to ${found.name} on the remote device.`
      },
    }),
    tool({
      name: 'remote_ping',
      description: 'Measure the cost of one background round trip to the target device without reusing any connection: connect, one api/bot state call, close. Reports per-stage milliseconds and the negotiated transport. Use this to compare LAN vs WAN behaviour.',
      parameters: {
        type: 'object',
        properties: {
          rounds: { type: 'integer', description: 'How many independent connect/close round trips to measure (default 3, max 10). Always a fresh connection per round.' },
        },
        additionalProperties: false,
      },
      async run(args) {
        const deviceId = await ensureTarget()
        const requested = Number(args?.rounds ?? 3)
        const rounds = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 10) : 3
        const samples = []
        for (let index = 0; index < rounds; index += 1) {
          const start = performance.now()
          const remote = await openPrivate(deviceId)
          const connected = performance.now()
          let transport
          try {
            transport = remote.client?.getStats?.()?.mode
          } catch { /* transport is best effort */ }
          try {
            await remote.client.rpc('plugin.route.call', { route: 'api/bot', body: { endpoint: 'state', payload: null } })
          } finally {
            const called = performance.now()
            try { await remote.client?.close?.() } catch { /* best effort */ }
            const closed = performance.now()
            samples.push({
              connect: Math.round(connected - start),
              call: Math.round(called - connected),
              close: Math.round(closed - called),
              total: Math.round(closed - start),
              transport: transport ?? 'unknown',
            })
          }
        }
        const totals = samples.map(sample => sample.total)
        const connects = samples.map(sample => sample.connect)
        const calls = samples.map(sample => sample.call)
        const avg = values => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)

        // Now measure the same call on a pooled (reused) connection. One warm-up
        // call builds the pool; it is measured separately so the per-call numbers
        // describe a real reuse hit and not the first connect.
        const warmupStart = performance.now()
        await withRemote(deviceId, async (remote) => {
          await remote.client.rpc('plugin.route.call', { route: 'api/bot', body: { endpoint: 'state', payload: null } })
        })
        const warmup = Math.round(performance.now() - warmupStart)

        const warm = []
        for (let index = 0; index < rounds; index += 1) {
          const start = performance.now()
          await withRemote(deviceId, async (remote) => {
            await remote.client.rpc('plugin.route.call', { route: 'api/bot', body: { endpoint: 'state', payload: null } })
          })
          warm.push(Math.round(performance.now() - start))
        }

        const lines = []
        lines.push(`target: ${targetDeviceId}`)
        lines.push(`transport: ${samples[0]?.transport ?? 'unknown'}`)
        lines.push('')
        lines.push(`cold (fresh connection each round, x${rounds}):`)
        for (const [index, sample] of samples.entries()) {
          lines.push(`  #${index + 1} connect=${sample.connect}ms call=${sample.call}ms close=${sample.close}ms total=${sample.total}ms`)
        }
        lines.push(`  avg connect=${avg(connects)}ms call=${avg(calls)}ms total=${avg(totals)}ms | min=${Math.min(...totals)}ms max=${Math.max(...totals)}ms`)
        lines.push('')
        lines.push(`warm (pooled connection, x${warm.length}):`)
        lines.push(`  warmup (opens the pool) = ${warmup}ms`)
        lines.push(`  ${warm.map(value => `${value}ms`).join(' / ')}`)
        lines.push(`  avg=${avg(warm)}ms`)
        const speedup = avg(warm) === 0 ? 'n/a' : `${(avg(totals) / avg(warm)).toFixed(1)}x`
        lines.push('')
        lines.push(`pooled reuse is ${speedup} faster per call than a cold connect+call`)
        return lines.join('\n')
      },
    }),
  ]

  const register = (tools) => {
    try {
      for (const spec of specs) tools.register(spec)
      log(ctx, `registered ${specs.length} tools`)
    } catch (error) {
      warn(ctx, `tool registration failed: ${error?.message ?? error}`)
    }
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (sub) => {
        const tools = sub?.tools
        if (tools === undefined || tools === null) {
          warn(ctx, 'tools service attached but empty')
          return
        }
        register(tools)
      })
    } else if (ctx.tools !== undefined) {
      register(ctx.tools)
    } else {
      warn(ctx, 'no tools service available; remote tools not registered')
    }
  } catch (error) {
    warn(ctx, `tools attach failed: ${error?.message ?? error}`)
  }
}
