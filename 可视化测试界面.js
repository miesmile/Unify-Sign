"ui";
/*
 * 可视化测试界面
 *
 * 作用：以可视化列表展示 config.js 中注册的所有签到功能（supported_signs），
 *      每个功能都可以①单独点击测试 ②勾选后点顶部「按顺序测试已勾选的功能」批量测试，
 *      不必再去 test/测试签到功能.js 里改注释切换脚本。
 *
 * 测试逻辑与 test/测试签到功能.js 一致：
 *   config.is_test = true + runner.setTest() + runner.exec()
 *   即测试模式下不受「今日已执行」记录限制，可反复调试，
 *   并且执行前会初始化 SQLite、申请无障碍、申请截屏权限（含自动处理「录制或共享屏幕」三步弹窗）。
 */

importClass(android.view.View)

let { config } = require('./config.js')(runtime, global)

let storage = storages.create('unify_sign_visual_test')
let checkedMap = storage.get('checked', {}) || {}
let allTasks = (config.supported_signs || []).slice()

ui.layout(
  <vertical>
    <vertical padding="12 10 12 8" bg="#ffffff">
      <text text="可视化测试界面" textSize="19sp" textStyle="bold" textColor="#212121" />
      <text id="subTitle" textSize="11sp" textColor="#9e9e9e" marginTop="2" />
      <button id="runChecked" text="按顺序测试已勾选的功能" marginTop="8" />
      <linear orientation="horizontal" marginTop="6">
        <button id="checkAll" text="全选" layout_weight="1" textSize="12sp" h="40" />
        <button id="uncheckAll" text="全不选" layout_weight="1" textSize="12sp" h="40" />
        <button id="stopBtn" text="停止" layout_weight="1" textSize="12sp" h="40" />
        <button id="exitBtn" text="退出" layout_weight="1" textSize="12sp" h="40" textColor="#c62828" />
      </linear>
      <text id="status" text="就绪：勾选功能后可批量测试，或点右侧「测试」单项执行" textSize="12sp"
        textColor="#1565c0" marginTop="6" />
      <scroll id="logScroll" h="150" bg="#1e1e1e" marginTop="6">
        <text id="logText" textSize="11sp" textColor="#b2dfdb" padding="6" />
      </scroll>
    </vertical>
    <linear h="1" bg="#e0e0e0" />
    <scroll layout_weight="1" bg="#f5f5f5">
      <vertical id="taskContainer" padding="8" />
    </scroll>
  </vertical>
)

ui.subTitle.setText('共 ' + allTasks.length + ' 个功能（来源：config.js 的 supported_signs）'
  + (config.device_width && config.device_width >= 10 ? '' : '｜提示：设备分辨率未初始化，建议先运行一次 main.js'))

// ---------------- 运行状态 ----------------
let running = false
let stopFlag = false
let worker = null
let rowRefs = []
let logLines = []

function nowStr () {
  let d = new Date()
  let p = function (n) { return (n < 10 ? '0' : '') + n }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function setStatus (text) {
  try {
    ui.run(function () {
      ui.status.setText(text)
    })
  } catch (e) {
    // 界面已销毁时忽略
  }
}

/**
 * 界面日志区追加一行（时间戳 + 内容），最多保留 150 行
 * 用于明确「开始/执行中/完成/异常中止/强制解绑」各阶段，脚本异常时也能一眼看出停在哪
 */
function appendLog (msg) {
  try {
    ui.run(function () {
      logLines.push(nowStr() + '  ' + msg)
      if (logLines.length > 150) {
        logLines.shift()
      }
      ui.logText.setText(logLines.join('\n'))
      try {
        ui.logScroll.fullScroll(android.view.View.FOCUS_DOWN)
      } catch (e) {
        // 滚动失败忽略
      }
    })
  } catch (e) {
    // 界面已销毁时忽略
  }
}

function finishRunUi () {
  running = false
  stopFlag = false
  try {
    ui.run(function () {
      ui.runChecked.setEnabled(true)
    })
  } catch (e) {
    // 忽略界面异常
  }
}

/**
 * 清理脚本执行期间绘制在屏幕上的框架日志浮窗（LogFloaty / WarningFloaty）
 * 脚本异常中止时这些悬浮窗可能残留，测试结束必须主动清掉
 */
function clearScreenFloaty () {
  try {
    let singletonRequire = require('./lib/SingletonRequirer.js')(runtime, global)
    let logFloaty = singletonRequire('LogFloaty')
    let warningFloaty = singletonRequire('WarningFloaty')
    ui.run(function () {
      try {
        if (logFloaty) {
          if (logFloaty.hide) {
            logFloaty.hide()
          }
          // 清掉缓存的历史日志行，避免下次执行时先闪出上一次的旧日志
          if (logFloaty.logQueue && logFloaty.logQueue._innerList) {
            logFloaty.logQueue._innerList = []
            logFloaty.logQueue.currentSize = 0
          }
        }
        if (warningFloaty) {
          if (warningFloaty.clearAll) {
            warningFloaty.clearAll('log')
          }
          // 触发一次重绘：disableTips 为 true 时会把画布清空并把悬浮窗移出屏幕
          if (warningFloaty.addText) {
            warningFloaty.addText('', { x: 0, y: 0 }, '#000000', 10, 'log')
          }
        }
      } catch (e) {
        // 单个清理步骤失败不影响其它
      }
    })
  } catch (e) {
    // 清理失败忽略（可能尚未初始化过浮窗）
  }
}

function collectChecked () {
  let entries = []
  allTasks.forEach(function (t) {
    if (checkedMap[t.taskCode]) {
      // 主任务已勾选：执行整个任务（忽略其子任务的勾选，避免重复执行）
      entries.push({ task: t, sub: null })
      return
    }
    let subList = t.subTasks || []
    subList.forEach(function (st) {
      if (checkedMap[t.taskCode + ':' + st.taskCode]) {
        entries.push({ task: t, sub: st })
      }
    })
  })
  return entries
}

function refreshRunButton () {
  let n = collectChecked().length
  ui.runChecked.setText(n > 0 ? '按顺序测试已勾选的功能（' + n + '）' : '按顺序测试已勾选的功能')
}

// ---------------- 构建功能列表 ----------------
allTasks.forEach(function (task) {
  let descParts = ['脚本：' + (task.script || '')]
  let subNames = (task.subTasks || []).map(function (st) {
    let disabled = (st.enabled === false || st.enabled === 'false')
    return st.taskName + (disabled ? '（禁用）' : '')
  })
  if (subNames.length > 0) {
    descParts.push('子任务：' + subNames.join('；'))
  }
  if (task.enabled === false || task.enabled === 'false') {
    descParts.push('配置中已禁用（测试时仍会执行）')
  }

  let row = ui.inflate(
    <vertical padding="8 6 8 0" bg="#ffffff">
      <linear orientation="horizontal" gravity="center_vertical">
        <checkbox id="chk" />
        <vertical layout_weight="1" marginLeft="4">
          <text id="taskTitle" textSize="15sp" textStyle="bold" textColor="#212121" />
          <text id="taskDesc" textSize="11sp" textColor="#9e9e9e" marginTop="1" />
        </vertical>
        <button id="testBtn" text="测试" textSize="12sp" w="70" h="38" />
      </linear>
      <linear h="1" bg="#eeeeee" marginTop="8" />
    </vertical>, ui.taskContainer, false)

  row.taskTitle.setText(task.name)
  row.taskDesc.setText(descParts.join('　'))
  row.chk.setChecked(!!checkedMap[task.taskCode])
  row.chk.on('check', function (checked) {
    checkedMap[task.taskCode] = checked
    storage.put('checked', checkedMap)
    refreshRunButton()
  })
  let doTest = function () {
    startRun([{ task: task, sub: null }], '单项测试：' + task.name)
  }
  row.testBtn.on('click', function () { doTest() })
  row.taskTitle.on('click', function () { doTest() })

  ui.taskContainer.addView(row)
  rowRefs.push({ key: task.taskCode, row: row })

  // 子任务行（单独测试时只执行该子任务，需脚本支持 onlySubTask 过滤）
  let subList = task.subTasks || []
  subList.forEach(function (st) {
    let subKey = task.taskCode + ':' + st.taskCode
    let disabled = (st.enabled === false || st.enabled === 'false')
    let subRow = ui.inflate(
      <linear orientation="horizontal" gravity="center_vertical" padding="6 4 6 4" bg="#fafafa">
        <checkbox id="chk" marginLeft="16" />
        <text id="subTitle" textSize="13sp" textColor="#424242" layout_weight="1" marginLeft="4" />
        <button id="subTestBtn" text="测试" textSize="11sp" w="64" h="34" />
      </linear>, ui.taskContainer, false)
    subRow.subTitle.setText('↳ ' + st.taskName + (disabled ? '（禁用）' : ''))
    subRow.chk.setChecked(!!checkedMap[subKey])
    subRow.chk.on('check', function (checked) {
      checkedMap[subKey] = checked
      storage.put('checked', checkedMap)
      refreshRunButton()
    })
    let doSubTest = function () {
      startRun([{ task: task, sub: st }], '子任务测试：' + task.name + ' - ' + st.taskName)
    }
    subRow.subTestBtn.on('click', function () { doSubTest() })
    subRow.subTitle.on('click', function () { doSubTest() })
    ui.taskContainer.addView(subRow)
    rowRefs.push({ key: subKey, row: subRow })
  })
})

refreshRunButton()

// ---------------- 顶部按钮 ----------------
ui.runChecked.on('click', function () {
  let checked = collectChecked()
  if (checked.length === 0) {
    toast('请先勾选要测试的功能')
    return
  }
  startRun(checked, '按顺序测试已勾选的功能')
})

ui.checkAll.on('click', function () {
  rowRefs.forEach(function (item) {
    let isSub = item.key.indexOf(':') >= 0
    checkedMap[item.key] = !isSub
    item.row.chk.setChecked(!isSub)
  })
  storage.put('checked', checkedMap)
  refreshRunButton()
})

ui.uncheckAll.on('click', function () {
  rowRefs.forEach(function (item) {
    checkedMap[item.key] = false
    item.row.chk.setChecked(false)
  })
  storage.put('checked', checkedMap)
  refreshRunButton()
})

let stopPressedAt = 0

ui.stopBtn.on('click', function () {
  if (!running) {
    // 没有任务在跑时，把可能残留的屏幕浮窗清掉，避免浮窗挂在那里关不掉
    clearScreenFloaty()
    setStatus('当前没有正在执行的测试，已清理屏幕浮窗')
    toast('已清理屏幕浮窗')
    return
  }
  let now = new Date().getTime()
  // 5 秒内第二次点击：强制解除界面绑定（脚本可能吞掉中断仍在后台跑）
  if (stopPressedAt && now - stopPressedAt < 5000) {
    stopPressedAt = 0
    stopFlag = true
    clearScreenFloaty()
    appendLog('⚠ 已强制解除界面绑定：脚本线程若仍存活会在后台继续，请注意观察')
    setStatus('已强制解除（线程可能仍在后台运行）')
    finishRunUi()
    return
  }
  stopPressedAt = now
  stopFlag = true
  setStatus('正在停止当前测试（如无反应可在5秒内再点一次强制解除）')
  appendLog('■ 请求停止：尝试中断脚本线程')
  try {
    if (worker) {
      worker.interrupt()
    }
  } catch (e) {
    // 忽略中断异常
  }
})

// 兜底监控：脚本线程已死但没走到结束流程（异常/被 exit 等）= 判定异常中止并复位界面
setInterval(function () {
  try {
    if (!running || !worker) {
      return
    }
    if (worker.isAlive && worker.isAlive()) {
      return
    }
    appendLog('⚠ 脚本线程已退出但未走到结束流程 → 判定为异常中止，界面已复位')
    setStatus('执行已中止（脚本线程异常退出）')
    clearScreenFloaty()
    finishRunUi()
  } catch (e) {
    // 监控异常忽略
  }
}, 1500)

// ---------------- 环境初始化（首次测试时执行一次） ----------------
let _env = null

function ensureEnv () {
  if (_env) {
    return _env
  }
  setStatus('首次执行：初始化环境（无障碍 / 数据库 / 截屏权限）...')
  let { config: cfg } = require('./config.js')(runtime, global)
  let singletonRequire = require('./lib/SingletonRequirer.js')(runtime, global)
  let commonFunctions = singletonRequire('CommonFunction')
  let runningQueueDispatcher = singletonRequire('RunningQueueDispatcher')
  let logUtils = singletonRequire('LogUtils')
  let signTaskService = singletonRequire('SignTaskService')

  cfg._debugging = true
  if (!commonFunctions.ensureAccessibilityEnabled()) {
    throw new Error('获取无障碍权限失败，请在系统设置中开启无障碍服务后重试')
  }
  try {
    signTaskService.init()
  } catch (e) {
    // PC 工程无 sign-task.db，真机才有；失败不阻断测试
    logUtils.warnInfo(['初始化数据库失败（若无 sqlite 可忽略）：{}', e])
  }
  commonFunctions.requestScreenCaptureOrRestart(true)
  cfg.is_test = true
  runningQueueDispatcher.addRunningTask()
  _env = {
    config: cfg,
    commonFunctions: commonFunctions,
    runningQueueDispatcher: runningQueueDispatcher,
    logUtils: logUtils
  }
  setStatus('环境初始化完成')
  return _env
}

// ---------------- 执行 ----------------
function startRun (list, title) {
  if (running) {
    toast('正在执行中，请等待当前测试结束或点「停止」')
    return
  }
  if (!list || list.length === 0) {
    toast('没有可测试的功能')
    return
  }
  running = true
  stopFlag = false
  ui.runChecked.setEnabled(false)
  setStatus(title + '：准备开始')
  appendLog('▶ 开始执行：' + title + '（共 ' + list.length + ' 项）')
  // 上次执行结束时隐藏过日志浮窗，这里恢复显示，保证本次执行期间屏幕日志正常
  try {
    let singletonRequire = require('./lib/SingletonRequirer.js')(runtime, global)
    let logFloaty = singletonRequire('LogFloaty')
    if (logFloaty && logFloaty.show) {
      logFloaty.show()
    }
  } catch (e) {
    // 忽略
  }

  try {
    worker = threads.start(function () {
    let okCount = 0
    let failList = []
    let env = null
    try {
      env = ensureEnv()
      for (let i = 0; i < list.length; i++) {
        if (stopFlag) {
          appendLog('■ 收到停止请求，中断剩余任务')
          break
        }
        let entry = list[i]
        let typeName = entry.sub ? (entry.task.name + ' - ' + entry.sub.taskName) : entry.task.name
        setStatus('执行中 ' + (i + 1) + '/' + list.length + '：' + typeName)
        appendLog('→ 【' + (i + 1) + '/' + list.length + '】' + typeName + ' 开始')
        try {
          let runner = require('./core/' + entry.task.script)
            .setName(typeName)
            .setTaskCode(entry.task.taskCode)
            .setSubTasks(entry.task.subTasks || [])
            .setTest()
          // 部分脚本会缓存上轮执行状态（如广告轮次计数），这里统一清理
          runner._adCount = 0
          // 指定只执行某个子任务；脚本未支持该字段时等同于执行整个任务
          runner.onlySubTask = entry.sub ? entry.sub.taskCode : null
          runner.exec()
          okCount++
          appendLog('✓ 【' + (i + 1) + '/' + list.length + '】' + typeName + ' 执行返回')
        } catch (e) {
          failList.push(typeName)
          appendLog('✗ 【' + (i + 1) + '/' + list.length + '】' + typeName + ' 异常中止：' + e)
          if (env) {
            env.logUtils.errorInfo(['任务执行异常：{} 错误：{}', typeName, e])
          }
        }
      }
    } catch (e) {
      failList.push('环境初始化')
      appendLog('✗ 环境初始化失败：' + e)
      if (env) {
        env.logUtils.errorInfo(['测试环境初始化异常：{}', e])
      }
      setStatus('环境初始化失败：' + e)
    } finally {
      if (env && env.runningQueueDispatcher) {
        try {
          env.runningQueueDispatcher.removeRunningTask()
        } catch (e) {
          // 忽略移除队列异常
        }
      }
      // 清理可能残留在屏幕上的框架日志浮窗（脚本异常中止时最容易残留）
      clearScreenFloaty()
      let summary
      if (failList.length === 0) {
        summary = '测试结束：成功 ' + okCount + ' 个'
      } else {
        summary = '测试结束：成功 ' + okCount + ' 个，失败 ' + failList.length + ' 个（' + failList.join('、') + '）'
      }
      appendLog('■ ' + summary + '（执行流程已全部结束）')
      setStatus(summary)
      finishRunUi()
    }
  })
  } catch (e) {
    // threads.start 异常（极少见）：复位界面，避免按钮永久禁用
    appendLog('✗ 启动执行线程失败：' + e)
    setStatus('启动执行线程失败：' + e)
    finishRunUi()
  }
}

// ---------------- 退出处理（保证任何时候都能退出，不再拦截返回键） ----------------
/**
 * 退出前清理：中断脚本线程 + 清屏幕浮窗
 * 放到独立线程执行，避免在 UI 线程里做浮窗操作导致界面卡死
 */
function teardownAndExit (byBackKey) {
  stopFlag = true
  running = false
  let w = worker
  try {
    if (w) {
      w.interrupt()
    }
  } catch (e) {
    // 忽略中断异常
  }
  try {
    threads.start(function () {
      try {
        sleep(300)
        clearScreenFloaty()
      } catch (e) {
        // 忽略
      }
    })
  } catch (e) {
    clearScreenFloaty()
  }
  if (byBackKey) {
    // 返回键退出：等系统把界面收掉后主动结束脚本，避免脚本残留在后台（AutoJS 重进仍显示本界面）
    setTimeout(function () {
      try {
        exit()
      } catch (e) {
        // 忽略
      }
    }, 600)
  } else {
    // 点「退出」按钮：直接结束脚本（界面随之关闭）
    exit()
  }
}

ui.exitBtn.on('click', function () {
  toastLog('退出测试界面')
  teardownAndExit(false)
})

ui.emitter.on('back_pressed', function (e) {
  // 关键：不再 consumed，返回键永远能退出界面（此前运行中拦截会退不出去、卡死）
  e.consumed = false
  teardownAndExit(true)
})

ui.emitter.on('exit', function () {
  // 界面销毁（返回键/系统回收）时兜底中断线程并清屏，避免脚本线程残留在后台
  try {
    if (running && worker) {
      stopFlag = true
      worker.interrupt()
    }
  } catch (e) {
    // 忽略
  }
  try {
    clearScreenFloaty()
  } catch (e) {
    // 忽略
  }
})
