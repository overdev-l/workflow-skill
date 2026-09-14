import assert from 'node:assert/strict'
import {
  antigravityProcesses,
  parseAntigravityBundle,
  scanAntigravityProcesses,
  assertAntigravityStopped,
  assertAntigravityStoppedStrict,
  withAntigravityAccountSwitch,
} from '../apps/desktop/electron/antigravity-runtime.ts'
import { AccountError } from '../packages/workflow-model/src/accounts.ts'

// 1. Pure parser compatibility with existing tests
{
  const fixture = [
    '1 /bin/sh',
    '2 /Users/u/.local/bin/agy',
    '3 /Applications/Antigravity.app/Contents/Resources/bin/language_server',
    '4 /other/language_server',
    '5 /Applications/Antigravity.app/Contents/MacOS/Antigravity',
  ].join('\n')
  assert.deepEqual(
    antigravityProcesses(fixture),
    ['agy', 'language_server', 'Antigravity'],
    'Existing parser output must remain identical for backward compatibility',
  )
}

// 2. Narrowed bundle detection and process classification (hostile, traversal, foreign, spaces)
{
  const validGui = '/Applications/Antigravity Support/Antigravity.app/Contents/MacOS/Antigravity'
  const validHelper = '/Applications/Antigravity Support/Antigravity.app/Contents/Resources/bin/language_server'
  const validElectronHelper = '/Applications/Antigravity Support/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper (Renderer)'

  // Valid paths
  const guiBundle = parseAntigravityBundle(validGui)
  assert.ok(guiBundle)
  assert.equal(guiBundle.bundlePath, '/Applications/Antigravity Support/Antigravity.app')
  assert.equal(guiBundle.isGui, true)
  assert.equal(guiBundle.isHelper, false)

  const helperBundle = parseAntigravityBundle(validHelper)
  assert.ok(helperBundle)
  assert.equal(helperBundle.bundlePath, '/Applications/Antigravity Support/Antigravity.app')
  assert.equal(helperBundle.isGui, false)
  assert.equal(helperBundle.isHelper, true)

  const electronBundle = parseAntigravityBundle(validElectronHelper)
  assert.ok(electronBundle)
  assert.equal(electronBundle.bundlePath, '/Applications/Antigravity Support/Antigravity.app')
  assert.equal(electronBundle.isGui, false)
  assert.equal(electronBundle.isHelper, true)

  // Hostile / non-exact / traversal paths must return null
  const hostileCases = [
    '../Applications/Antigravity.app/Contents/MacOS/Antigravity', // relative path
    'Antigravity.app/Contents/MacOS/Antigravity', // relative path
    '/Applications/Antigravity.app/Contents/MacOS/../MacOS/Antigravity', // traversal
    '/Applications/Antigravity.app/../Antigravity.app/Contents/MacOS/Antigravity', // traversal
    '/Applications/Antigravity Other.app/Contents/MacOS/Antigravity', // broad alternate bundle name
    '/Applications/Antigravity 2.app/Contents/MacOS/Antigravity', // numbered alternate bundle
    '/Applications/Antigravity.app/Contents/MacOS/foo/Antigravity', // nested binary under Contents/MacOS
    '/Applications/OtherApp.app/Contents/MacOS/Antigravity', // foreign app
    '/other/language_server', // non-bundle helper
    '', // empty
  ]

  for (const hostilePath of hostileCases) {
    assert.equal(
      parseAntigravityBundle(hostilePath),
      null,
      `Hostile/foreign path must be rejected: ${hostilePath}`,
    )
  }

  const psOutput = [
    `100 ${validGui}`,
    `101 ${validHelper}`,
    '200 /Users/tester/bin/agy',
    '300 /Applications/Antigravity Other.app/Contents/MacOS/Antigravity',
    '301 /Applications/Antigravity.app/Contents/MacOS/foo/Antigravity',
    '302 /other/language_server',
  ].join('\n')

  const scan = scanAntigravityProcesses(psOutput)
  assert.deepEqual(scan.cliPids, [200])
  assert.equal(scan.guiProcesses.length, 1)
  assert.equal(scan.guiProcesses[0].pid, 100)
  assert.equal(scan.guiProcesses[0].bundlePath, '/Applications/Antigravity Support/Antigravity.app')
  assert.equal(scan.helperProcesses.length, 1)
  assert.equal(scan.helperProcesses[0].pid, 101)
}

// 3. CLI active switch succeeds / CLI never killed, spawned or terminated
{
  const cliOnlyPs = '101 /Users/tester/.local/bin/agy\n1 /bin/sh'
  const quitCalls = []
  const openCalls = []
  let writeCalled = false

  const deps = {
    getPsOutput: () => cliOnlyPs,
    getPsOutputAsync: async () => cliOnlyPs,
    quitApp: async bundle => { quitCalls.push(bundle) },
    openApp: async bundle => { openCalls.push(bundle) },
    sleep: async () => {},
    now: () => Date.now(),
  }

  const result = await withAntigravityAccountSwitch(async () => {
    writeCalled = true
    assertAntigravityStopped()
    return { success: true }
  }, deps)

  assert.equal(result.success, true)
  assert.equal(writeCalled, true)
  assert.equal(quitCalls.length, 0, 'CLI must not trigger quitApp')
  assert.equal(openCalls.length, 0, 'CLI must not trigger openApp')
}

// 4. Background blocked simultaneously (ALS lease isolation) and message differences
{
  const cliOnlyPs = '101 /Users/tester/.local/bin/agy'
  const deps = {
    getPsOutput: () => cliOnlyPs,
    getPsOutputAsync: async () => cliOnlyPs,
    sleep: async () => {},
    now: () => Date.now(),
  }

  // Outside switch: strict guard asks to quit both
  assert.throws(
    () => assertAntigravityStopped(deps),
    err => err instanceof AccountError && err.message.includes('所有 agy CLI 会话'),
    'Background guard must mention ending all agy CLI sessions',
  )
  assert.throws(
    () => assertAntigravityStoppedStrict(deps),
    err => err instanceof AccountError && err.message.includes('所有 agy CLI 会话') && err.message.includes('续期'),
    'Strict guard must mention renewal and quitting both client and CLI',
  )

  let backgroundSawBlocked = false
  let interactiveSucceeded = false

  let triggerBackground
  const backgroundTrigger = new Promise(resolve => { triggerBackground = resolve })
  let backgroundDone
  const backgroundFinished = new Promise(resolve => { backgroundDone = resolve })

  const backgroundTask = (async () => {
    await backgroundTrigger
    try {
      assertAntigravityStopped(deps)
    } catch (err) {
      if (/先退出/.test(err.message)) {
        backgroundSawBlocked = true
      }
    } finally {
      backgroundDone()
    }
  })()

  await withAntigravityAccountSwitch(async () => {
    assert.doesNotThrow(() => assertAntigravityStopped())
    interactiveSucceeded = true

    assert.throws(() => assertAntigravityStoppedStrict(), /所有 agy CLI 会话/)

    triggerBackground()
    await backgroundFinished
    return { success: true }
  }, deps)

  await backgroundTask
  assert.equal(interactiveSucceeded, true, 'Interactive assertAntigravityStopped must succeed')
  assert.equal(backgroundSawBlocked, true, 'Simultaneous background check must be blocked on CLI')
}

// 5. Interactive guard message when GUI remains running (specific message without demanding CLI quit)
{
  const guiPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  const deps = {
    getPsOutput: () => guiPs,
    getPsOutputAsync: async () => guiPs,
    sleep: async () => {},
    now: () => Date.now(),
  }

  await withAntigravityAccountSwitch(async () => {
    assert.throws(
      () => assertAntigravityStopped(),
      err => {
        return (
          err instanceof AccountError &&
          err.message.includes('客户端仍在运行') &&
          err.message.includes('重试') &&
          !err.message.includes('结束所有 agy CLI 会话')
        )
      },
      'Interactive GUI guard must specify client remains running without demanding CLI quit',
    )
    return { success: true }
  }, {
    ...deps,
    // Provide an initial ps without GUI so withAntigravityAccountSwitch enters operation
    getPsOutputAsync: async () => '',
  })
}

// 6. Direct strict assert check inside active interactive lease
{
  const cliOnlyPs = '101 /Users/tester/.local/bin/agy'
  const deps = {
    getPsOutput: () => cliOnlyPs,
    getPsOutputAsync: async () => cliOnlyPs,
    sleep: async () => {},
    now: () => Date.now(),
  }

  await withAntigravityAccountSwitch(async () => {
    assert.doesNotThrow(() => assertAntigravityStopped())
    assert.throws(
      () => assertAntigravityStoppedStrict(),
      /先退出.*所有 agy CLI 会话/,
      'assertAntigravityStoppedStrict must always block on agy CLI even inside active interactive lease',
    )
    return { success: true }
  }, deps)
}

// 7. Desktop quit -> write -> restart ordering
{
  let currentPs = [
    '101 /Users/tester/.local/bin/agy',
    '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity',
    '202 /Applications/Antigravity.app/Contents/Resources/bin/language_server',
  ].join('\n')

  const events = []
  const deps = {
    getPsOutput: () => currentPs,
    getPsOutputAsync: async () => currentPs,
    quitApp: async bundlePath => {
      events.push(['quit', bundlePath])
      currentPs = '101 /Users/tester/.local/bin/agy'
    },
    openApp: async bundlePath => {
      events.push(['open', bundlePath])
    },
    sleep: async () => {},
    now: () => Date.now(),
    timeoutMs: 1000,
  }

  const result = await withAntigravityAccountSwitch(async () => {
    events.push(['write'])
    assertAntigravityStopped()
    return { success: true }
  }, deps)

  assert.equal(result.success, true)
  assert.deepEqual(events, [
    ['quit', '/Applications/Antigravity.app'],
    ['write'],
    ['open', '/Applications/Antigravity.app'],
  ], 'Lifecycle must execute strictly in order: quit -> write -> open')
}

// 8. Cancel / timeout no write (no duplicate open when GUI still running)
{
  const hangingPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  let currentTime = 1000
  let writeCalled = false
  const openCalls = []

  const timeoutDeps = {
    getPsOutput: () => hangingPs,
    getPsOutputAsync: async () => hangingPs,
    quitApp: async () => {},
    openApp: async bundle => { openCalls.push(bundle) },
    sleep: async () => { currentTime += 200 },
    now: () => currentTime,
    timeoutMs: 500,
    pollIntervalMs: 100,
  }

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      writeCalled = true
      return { success: true }
    }, timeoutDeps),
    err => err instanceof AccountError && err.message.includes('超时') && err.message.includes('重试'),
    'Must time out with retry suggestion if GUI does not exit before timeoutMs',
  )
  assert.equal(writeCalled, false, 'Operation must NOT be executed on timeout')
  assert.equal(openCalls.length, 0, 'App must not be duplicated if switch timed out and GUI is still running')

  // Cancel via AbortSignal with GUI still running
  const controller = new AbortController()
  controller.abort()
  writeCalled = false

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      writeCalled = true
      return { success: true }
    }, { ...timeoutDeps, signal: controller.signal }),
    /取消/,
    'Must reject when signal is aborted',
  )
  assert.equal(writeCalled, false, 'Operation must NOT be executed on abort')
  assert.equal(openCalls.length, 0, 'Still-running GUI must NOT be duplicated on abort')
}

// 9. Pre-operation failure after successful quit: restore previously running app
{
  // 9a: Abort after quit confirmed gone -> restore app
  let currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  let openCalledWith = null
  let writeCalled = false
  const abortCtrl = new AbortController()

  const abortAfterQuitDeps = {
    getPsOutput: () => currentPs,
    getPsOutputAsync: async () => currentPs,
    quitApp: async () => {
      currentPs = '' // Client quits
      abortCtrl.abort() // User aborts right after quit
    },
    openApp: async bundle => { openCalledWith = bundle },
    sleep: async () => {},
    now: () => Date.now(),
    signal: abortCtrl.signal,
  }

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      writeCalled = true
      return { success: true }
    }, abortAfterQuitDeps),
    /取消/,
  )
  assert.equal(writeCalled, false, 'Write must not be called on abort')
  assert.equal(openCalledWith, '/Applications/Antigravity.app', 'App must be restored after quit if aborted')

  // 9b: Poll scan failure after quit: cannot verify gone -> avoid launch if unknown, safe error
  currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  let openAttempted = false
  writeCalled = false

  const scanFailDeps = {
    getPsOutput: () => currentPs,
    getPsOutputAsync: async () => {
      if (currentPs === '') throw new Error('ps daemon crashed')
      return currentPs
    },
    quitApp: async () => { currentPs = '' },
    openApp: async () => { openAttempted = true },
    sleep: async () => {},
    now: () => Date.now(),
  }

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      writeCalled = true
      return { success: true }
    }, scanFailDeps),
    err => err instanceof AccountError && err.message.includes('手动重新打开'),
  )
  assert.equal(writeCalled, false)
  assert.equal(openAttempted, false, 'Must avoid launch if ps scan failure prevents verification')

  // 9c: Originally absent app must NOT be launched on abort
  let absentOpenCalled = false
  const abortCtrl2 = new AbortController()
  abortCtrl2.abort()

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      return { success: true }
    }, {
      getPsOutput: () => '',
      getPsOutputAsync: async () => '',
      openApp: async () => { absentOpenCalled = true },
      sleep: async () => {},
      now: () => Date.now(),
      signal: abortCtrl2.signal,
    }),
    /取消/,
  )
  assert.equal(absentOpenCalled, false, 'Do not launch app if it was not originally running')
}

// 10. osascript command failure / explicit cancellation
{
  let currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  let openCalled = false
  let writeCalled = false

  const quitErrorDeps = {
    getPsOutput: () => currentPs,
    getPsOutputAsync: async () => currentPs,
    quitApp: async () => {
      throw new Error('osascript: User canceled (-128)')
    },
    openApp: async () => { openCalled = true },
    sleep: async () => {},
    now: () => Date.now(),
  }

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      writeCalled = true
      return { success: true }
    }, quitErrorDeps),
    err => err instanceof AccountError && err.message.includes('退出 Antigravity 客户端失败或已取消'),
  )
  assert.equal(writeCalled, false, 'Must not write credentials if quit command failed')
  assert.equal(openCalled, false, 'Must not duplicate app if GUI is still running after quit failure')
}

// 11. Orphan helper cases: safe blocking without arbitrary kill & do not launch app if not running
{
  const orphanHelperPs = '202 /Applications/Antigravity.app/Contents/Resources/bin/language_server'
  let currentTime = 0
  let quitCalled = false
  let openCalled = false
  let writeCalled = false

  const orphanTimeoutDeps = {
    getPsOutput: () => orphanHelperPs,
    getPsOutputAsync: async () => orphanHelperPs,
    quitApp: async () => { quitCalled = true },
    openApp: async () => { openCalled = true },
    sleep: async () => { currentTime += 200 },
    now: () => currentTime,
    timeoutMs: 500,
  }

  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      writeCalled = true
      return { success: true }
    }, orphanTimeoutDeps),
    err => err instanceof AccountError && err.message.includes('辅助进程') && err.message.includes('重试'),
  )
  assert.equal(writeCalled, false, 'Write must not be called when orphan helper fails to exit')
  assert.equal(quitCalled, false, 'Orphan helpers must not be arbitrarily quit via osascript')
  assert.equal(openCalled, false, 'App must not be launched when it was not running')

  let pollCount = 0
  let dynamicPs = orphanHelperPs
  quitCalled = false
  openCalled = false
  writeCalled = false

  const orphanExitsDeps = {
    getPsOutput: () => dynamicPs,
    getPsOutputAsync: async () => {
      if (++pollCount > 1) dynamicPs = ''
      return dynamicPs
    },
    quitApp: async () => { quitCalled = true },
    openApp: async () => { openCalled = true },
    sleep: async () => {},
    now: () => Date.now(),
    timeoutMs: 1000,
  }

  const orphanResult = await withAntigravityAccountSwitch(async () => {
    writeCalled = true
    return { success: true }
  }, orphanExitsDeps)

  assert.equal(orphanResult.success, true)
  assert.equal(writeCalled, true)
  assert.equal(quitCalled, false)
  assert.equal(openCalled, false, 'Do not launch app if desktop was not originally running')
}

// 12. Restart failure returns success: true + warning static string
{
  let currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  const restartFailDeps = {
    getPsOutput: () => currentPs,
    getPsOutputAsync: async () => currentPs,
    quitApp: async () => { currentPs = '' },
    openApp: async () => {
      throw new Error('Synthetic /usr/bin/open spawn failure')
    },
    sleep: async () => {},
    now: () => Date.now(),
  }

  const result = await withAntigravityAccountSwitch(async () => {
    return { success: true }
  }, restartFailDeps)

  assert.equal(result.success, true, 'Operation succeeded so switch must report success: true')
  assert.ok(typeof result.warning === 'string' && result.warning.length > 0, 'Warning static string must be populated')
  assert.match(result.warning, /重新启动.*失败|手动打开/)
}

// 13. Operation error handling: throw null, throw undefined, invalid result, AccountError
{
  let currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  let openCalledCount = 0

  const opDeps = {
    getPsOutput: () => currentPs,
    getPsOutputAsync: async () => currentPs,
    quitApp: async () => { currentPs = '' },
    openApp: async () => { openCalledCount++ },
    sleep: async () => {},
    now: () => Date.now(),
  }

  // 13a: throw null must NOT be swallowed or return success: true
  openCalledCount = 0
  currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      throw null // eslint-disable-line no-throw-literal
    }, opDeps),
    err => err instanceof AccountError && err.message.includes('异常中止'),
    'throw null must throw safe AccountError and never return success',
  )
  assert.equal(openCalledCount, 1, 'Desktop app must still be restored if operation threw null')

  // 13b: throw undefined
  openCalledCount = 0
  currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      throw undefined // eslint-disable-line no-throw-literal
    }, opDeps),
    err => err instanceof AccountError && err.message.includes('异常中止'),
  )
  assert.equal(openCalledCount, 1, 'Desktop app must still be restored if operation threw undefined')

  // 13c: operation returns undefined
  currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      return undefined // invalid result
    }, opDeps),
    err => err instanceof AccountError && err.message.includes('无效的结果'),
  )

  // 13d: operation returns empty object or non-boolean success
  currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      return {} // invalid result
    }, opDeps),
    err => err instanceof AccountError && err.message.includes('无效的结果'),
  )

  // 13e: operation throws AccountError
  openCalledCount = 0
  currentPs = '201 /Applications/Antigravity.app/Contents/MacOS/Antigravity'
  await assert.rejects(
    withAntigravityAccountSwitch(async () => {
      throw new AccountError('写入凭据失败：Keychain 拒绝访问。')
    }, opDeps),
    /Keychain 拒绝访问/,
  )
  assert.equal(openCalledCount, 1, 'Desktop app must still be restored if operation threw AccountError')
}

// 14. Lease revoked / detached task cannot bypass guard
{
  let detachedCheck = null
  const cliPs = '101 /Users/tester/.local/bin/agy'

  const deps = {
    getPsOutput: () => cliPs,
    getPsOutputAsync: async () => cliPs,
    sleep: async () => {},
    now: () => Date.now(),
  }

  await withAntigravityAccountSwitch(async () => {
    detachedCheck = () => assertAntigravityStopped(deps)
    return { success: true }
  }, deps)

  assert.ok(detachedCheck)
  assert.throws(
    () => detachedCheck(),
    /先退出/,
    'Expired lease must not allow detached tasks to ignore agy CLI',
  )
}

// 15. Foreign processes not killed or quit
{
  const foreignPs = [
    '300 /other/language_server',
    '301 /Applications/OtherApp.app/Contents/MacOS/Antigravity',
    '302 /usr/bin/python',
  ].join('\n')

  let quitTriggered = false
  let openTriggered = false

  const foreignDeps = {
    getPsOutput: () => foreignPs,
    getPsOutputAsync: async () => foreignPs,
    quitApp: async () => { quitTriggered = true },
    openApp: async () => { openTriggered = true },
    sleep: async () => {},
    now: () => Date.now(),
  }

  const result = await withAntigravityAccountSwitch(async () => {
    return { success: true }
  }, foreignDeps)

  assert.equal(result.success, true)
  assert.equal(quitTriggered, false, 'Foreign process must not be quit')
  assert.equal(openTriggered, false, 'Foreign process must not be launched')
}

// 16. Scan failures safely caught without leaking raw stderr
{
  const failingDeps = {
    getPsOutput: () => { throw new Error('ps: /bin/ps died with SIGSEGV') },
    getPsOutputAsync: async () => { throw new Error('ps: /bin/ps died with SIGSEGV') },
    sleep: async () => {},
    now: () => Date.now(),
  }

  assert.throws(
    () => assertAntigravityStopped(failingDeps),
    err => err instanceof AccountError && !err.message.includes('SIGSEGV') && err.message.includes('无法检查'),
    'Sync scan failure must throw sanitized AccountError',
  )

  await assert.rejects(
    withAntigravityAccountSwitch(async () => ({ success: true }), failingDeps),
    err => err instanceof AccountError && !err.message.includes('SIGSEGV') && err.message.includes('无法检查'),
    'Async scan failure must throw sanitized AccountError',
  )
}

// 17. Concurrent interactive runs serialized
{
  let run1Started = false, run1Finished = false
  let run2Started = false, run2Finished = false

  const slowDeps = {
    getPsOutput: () => '',
    getPsOutputAsync: async () => '',
    sleep: async () => {},
    now: () => Date.now(),
  }

  const p1 = withAntigravityAccountSwitch(async () => {
    run1Started = true
    await new Promise(r => setTimeout(r, 20))
    run1Finished = true
    return { success: true }
  }, slowDeps)

  const p2 = withAntigravityAccountSwitch(async () => {
    run2Started = true
    assert.equal(run1Finished, true, 'Run 1 must finish before Run 2 starts')
    run2Finished = true
    return { success: true }
  }, slowDeps)

  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.success, true)
  assert.equal(r2.success, true)
  assert.equal(run1Finished, true)
  assert.equal(run2Finished, true)
}

console.log('Antigravity switch runtime verification passed: all 17 suites succeeded.')
