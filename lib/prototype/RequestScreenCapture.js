/*
 * @Author: TonyJiangWJ
 * @Date: 2020-12-30 20:16:48
 * @Last Modified by: TonyJiangWJ
 * @Last Modified time: 2025-05-29 10:22:15
 * @Description: 
 */
let { config } = require('../../config.js')(runtime, global)
let singletonRequire = require('../SingletonRequirer.js')(runtime, global)
let widgetUtils = singletonRequire('WidgetUtils')
let logUtils = singletonRequire('LogUtils')
let automator = singletonRequire('Automator')

/**
 * 新式弹窗操作步骤（严格固定文案，不做模糊/类似匹配）：
 * 1. 点击「共享或录制的范围」
 * 2. 点击「共享整个屏幕」
 * 3. 点击「开始」或「继续」
 */
const SCOPE_ROW_TEXT = '共享或录制的范围'
const FULL_SCREEN_TEXT = '共享整个屏幕'
const CONFIRM_START_TEXT = '开始'
const CONFIRM_CONTINUE_TEXT = '继续'

/**
 * 老式弹窗确认按钮文案（固定文案，按顺序尝试）
 */
const LEGACY_CONFIRM_TEXTS = ['立即开始', '允许', 'START NOW']

/**
 * 按固定文案精确查找控件（text 精确匹配，不做包含/模糊匹配）
 */
function findExactText (text, timeout) {
  try {
    return selector().text(text).findOne(timeout)
  } catch (e) {
    return null
  }
}

/**
 * 点击目标控件，成功返回 true
 */
function clickTarget (target, desc) {
  if (!target) {
    return false
  }
  try {
    if (automator.checkCenterClickable(target)) {
      automator.clickCenter(target)
      sleep(250)
      logUtils.debugInfo('已点击：' + desc)
      return true
    }
  } catch (e) {
    logUtils.debugInfo('点击失败 ' + desc + '：' + e)
  }
  return false
}

/**
 * 处理系统「使用XX录制或共享屏幕」授权弹窗
 *
 * 严格按固定文案顺序执行（不做模糊匹配）：
 * 1. 点击「共享或录制的范围」
 * 2. 点击「共享整个屏幕」
 * 3. 点击「开始 / 继续」
 * 步骤2未找到时中止，避免只点确认按钮导致共享范围错误
 *
 * @returns {boolean} 是否处理成功
 */
function handleScreenShareDialogIfNeeded () {
  // 步骤1：点击「共享或录制的范围」（新式弹窗的标志）
  let row = findExactText(SCOPE_ROW_TEXT, 1200)
  if (row && clickTarget(row, SCOPE_ROW_TEXT)) {
    sleep(400)
    // 步骤2：点击「共享整个屏幕」
    let fullScreen = findExactText(FULL_SCREEN_TEXT, 2000)
    if (!fullScreen || !clickTarget(fullScreen, FULL_SCREEN_TEXT)) {
      logUtils.warnInfo('未找到「共享整个屏幕」，中止自动处理，请手动完成授权')
      return false
    }
    sleep(300)
    // 勾选「不再询问」（尽力而为，部分系统弹窗提供，勾选后不再每次弹窗）
    let remember = widgetUtils.widgetGetById('android:id/checkbox', 300)
    if (!remember) {
      remember = widgetUtils.widgetGetById('com.android.systemui:id/remember', 300)
    }
    if (remember) {
      clickTarget(remember, '不再询问')
    }
    // 步骤3：点击「开始」，找不到再点「继续」
    let confirm = findExactText(CONFIRM_START_TEXT, 1500) || findExactText(CONFIRM_CONTINUE_TEXT, 1500)
    if (confirm && clickTarget(confirm, '开始/继续')) {
      sleep(300)
      return true
    }
    logUtils.warnInfo('未找到「开始/继续」按钮')
    return false
  }
  // 老式弹窗：直接按固定文案点击确认按钮
  for (let i = 0; i < LEGACY_CONFIRM_TEXTS.length; i++) {
    if (clickTarget(findExactText(LEGACY_CONFIRM_TEXTS[i], 800), LEGACY_CONFIRM_TEXTS[i])) {
      sleep(300)
      return true
    }
  }
  return false
}

// 将处理函数挂载到导出对象上，供其它模块（如 MainExecutor）在任务执行前调用
module.exports = function (landscape) {
  let countDown = new java.util.concurrent.CountDownLatch(1)
  let requestSuccess = false
  let confirmWaitingThread = threads.start(function () {
    sleep(500)
    if (requestSuccess) {
      return
    }
    logUtils.warnInfo(['建议通过ADB授权截图权限，具体见常见问题，授权命令：adb shell appops set {} PROJECT_MEDIA allow', context.packageName])
    // 优先处理「录制或共享屏幕」新式弹窗；处理失败再尝试老式确认按钮
    let handled = handleScreenShareDialogIfNeeded()
    if (handled) {
      logUtils.debugInfo('自动处理截图授权弹窗完成')
    } else {
      logUtils.warnInfo('未找到截图授权弹窗确认按钮，请手动完成授权', true)
    }
    countDown.countDown()
  })
  let requestThread = threads.start(function () {
    requestSuccess = requestScreenCapture(landscape)
    countDown.countDown()
  })
  let waitResult = countDown.await(15, java.util.concurrent.TimeUnit.SECONDS)
  if (!waitResult) {
    logUtils.warnInfo('请求截屏权限超时')
  }
  logUtils.debugInfo('请求截屏权限结束：' + requestSuccess)
  if (!requestSuccess) {
    logUtils.warnInfo('请求截屏权限失败，如果显示选择应用范围，请在开发者选项中开启 停用屏幕共享防护 具体见常见问题', true)
  }
  confirmWaitingThread.interrupt()
  requestThread.interrupt()
  return requestSuccess
}

module.exports.handleScreenShareDialogIfNeeded = handleScreenShareDialogIfNeeded
