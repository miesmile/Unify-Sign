/*
 * 云宝宝看广告赚云币
 *
 * 流程说明：
 * 1. 打开云宝宝 -> 点击主界面下方「赚云币」Tab 进入赚云币页面
 * 2. 依次处理页面上的看广告元素：
 *    - 惊喜礼包：图片控件(res:id/iv_treasure_box) -> 点击 -> 弹窗 -> 点击「观看视频后开启」-> 看广告
 *    - 每日打卡：点击 -> 进入打卡页 -> 三个看视频入口（看视频，领*** / 看N次视频补领 / 看视频领取）
 *      已领取时点击无反应且无法判断，全部点一遍，打开的广告看满后返回
 *    - 每日看视频10次：点击文字右侧的「进行中」按钮 -> 直接看广告（可重复，最多10次）
 *    - 开宝箱赚云币：图片控件(res:id/cl_bg) -> 与惊喜礼包一致
 * 3. 广告开始后分两种结束方式：
 *    - 直接看满：读取右上角倒计时 t，等待 t 秒（或提前检测到奖励/可关闭状态），领取奖励后关闭广告
 *    - 跳转类广告：命中跳转文案（我要加速领奖励 / 跳转APP领奖励 等，见下方 JUMP_AD_CASES 情况表），
 *      点击跳转后等待 t + 5~10s，返回云宝宝后领取奖励并关闭广告
 *
 * 注意事项：
 * - 包名：公开资料显示应用宝官方「云宝宝星耀强化版」包名为 com.babystar.enhanced；
 *   若手机上安装的是其它版本/渠道包，请在手机上执行 adb shell pm list packages 查询实际包名后修改 _package_name
 * - 跳转文案情况表见 JUMP_AD_CASES，遇到新的跳转文案直接往表里加即可
 */

let { config } = require('../config.js')(runtime, this)
let singletonRequire = require('../lib/SingletonRequirer.js')(runtime, this)
let commonFunctions = singletonRequire('CommonFunction')
let widgetUtils = singletonRequire('WidgetUtils')
let logUtils = singletonRequire('LogUtils')
let automator = singletonRequire('Automator')
let localOcrUtil = require('../lib/LocalOcrUtil.js')

let BaseSignRunner = require('./BaseSignRunner.js')

/**
 * 跳转类广告文案情况表
 * 命中表中的任意文案，都按「跳转App领取」方式处理：点击跳转 -> 等待倒计时 t + 5~10s -> 返回应用 -> 关闭广告
 * 已知：我要加速领奖励 / 跳转APP领奖励 / 去体验X秒后可拿奖励 等。
 * 注意：只要广告页存在跳转按钮，就应判定为跳转类（即使上方同时有倒计时引导文案）。
 * 遇到新的跳转文案在这里追加即可。
 */
const JUMP_AD_CASES = [
  { regex: /我要加速领奖励/, desc: '我要加速领奖励' },
  { regex: /跳转\s*[Aa][Pp][Pp]\s*领奖励/, desc: '跳转APP领奖励' },
  { regex: /跳转\s*[Aa][Pp][Pp]\s*领取奖励/, desc: '跳转APP领取奖励' },
  { regex: /加速领奖励/, desc: '加速领奖励' },
  { regex: /加速.{0,6}(领取|领奖)/, desc: '加速领取/领奖' },
  { regex: /打开.{0,4}(领奖励|领取奖励)/, desc: '打开XX领奖励' },
  { regex: /前往.{0,4}(领奖励|领取奖励)/, desc: '前往XX领奖励' },
  { regex: /去.{0,10}(拿奖励|领取奖励|领奖励)/, desc: '去XX拿奖励' },
  { regex: /去体验.{0,8}(拿奖励|领奖励|领取奖励)/, desc: '去体验X秒后可拿奖励' },
  { regex: /体验.{0,6}(拿奖励|领奖励|领取奖励)/, desc: '体验后拿奖励' },
  { regex: /点击打开或下载第三方应用/, desc: '点击打开或下载第三方应用' },
  { regex: /打开或下载第三方应用/, desc: '打开或下载第三方应用' },
  { regex: /下载第三方应用/, desc: '下载第三方应用' },
]

/**
 * 判断一段文案是否为跳转类广告文案
 * 先匹配已知情况表，再走兜底启发式：领取类文案 + 动作词
 */
function isJumpAdText (text) {
  if (!text) {
    return false
  }
  text = String(text).replace(/\s+/g, '')
  for (let i = 0; i < JUMP_AD_CASES.length; i++) {
    if (JUMP_AD_CASES[i].regex.test(text)) {
      logUtils.debugInfo(['命中跳转文案情况表[{}]：{}', JUMP_AD_CASES[i].desc, text])
      return true
    }
  }
  // 兜底启发式：领取/拿奖励类文案 + 动作词，尽量覆盖未收录的新文案
  // 注意：不含「秒」，避免把「观看视频5秒后可领取奖励」这类普通倒计时文案误判为跳转
  if (/(领奖励|领取奖励|领奖|去领|拿奖励)/.test(text) && /(加速|跳转|立即|前往|去|打开|点|体验|下载|安装)/.test(text)) {
    logUtils.debugInfo(['命中跳转文案启发式：{}', text])
    return true
  }
  return false
}

function buildJumpRegex () {
  let sources = JUMP_AD_CASES.map(c => c.regex.source)
  if (!sources || sources.length === 0) {
    return null
  }
  return sources.join('|')
}

/**
 * 「继续看视频」类文案情况表
 * 广告过程中出现此类文案时，优先点击「继续」留在应用内看完，能不跳转就不跳转。
 * 命中表中的文案会被当作「继续」按钮点击，不会触发跳转。
 * 遇到新的继续文案在这里追加即可。
 */
const CONTINUE_AD_CASES = [
  { regex: /继续\s*(看|观看|播放)\s*视频/, desc: '继续看视频' },
  { regex: /继续\s*(看|观看)\s*广告/, desc: '继续看广告' },
  { regex: /继续\s*播放/, desc: '继续播放' },
  { regex: /继续\s*观看/, desc: '继续观看' },
  { regex: /^继续$/, desc: '继续按钮' },
]

/**
 * 判断一段文案是否为「继续看视频」类文案
 */
function isContinueAdText (text) {
  if (!text) {
    return false
  }
  text = String(text).replace(/\s+/g, '')
  for (let i = 0; i < CONTINUE_AD_CASES.length; i++) {
    if (CONTINUE_AD_CASES[i].regex.test(text)) {
      logUtils.debugInfo(['命中继续文案情况表[{}]：{}', CONTINUE_AD_CASES[i].desc, text])
      return true
    }
  }
  return false
}

/**
 * 从文本中解析广告倒计时秒数
 * 支持格式：00:05 / 05:12、5s、5秒、5 sec、纯数字5
 */
function parseSeconds (text) {
  if (!text) {
    return null
  }
  text = String(text).trim()
  let m = /(\d{1,2}):(\d{1,2})/.exec(text)
  if (m) {
    return parseInt(m[1]) * 60 + parseInt(m[2])
  }
  m = /(\d{1,3})\s*(秒|s|sec)/i.exec(text)
  if (m) {
    return parseInt(m[1])
  }
  m = /^\s*(\d{1,3})\s*$/.exec(text)
  if (m) {
    return parseInt(m[1])
  }
  return null
}

function SignRunner () {
  BaseSignRunner.call(this)

  // ⚠️ 云宝宝 App 包名：公开资料显示应用宝官方「云宝宝星耀强化版」为 com.babystar.enhanced
  // 若实际包名不同，请修改此处
  let _package_name = 'com.babystar.enhanced'
  let _app_name = '云宝宝'

  // 子任务（与 config.js 中 supported_signs 的 subTasks 对应，可在配置中单独开关）
  this.subTasks = (config.supported_signs.filter(task => task.taskCode === 'Yunbaobao')[0] || {}).subTasks || [
    {
      taskCode: 'giftPackage',
      taskName: '惊喜礼包',
      enabled: true,
    },
    {
      taskCode: 'dailyCheckIn',
      taskName: '每日打卡',
      enabled: true,
    },
    {
      taskCode: 'dailyWatchVideo',
      taskName: '每日看视频10次',
      enabled: true,
    },
    {
      taskCode: 'openBox',
      taskName: '开宝箱赚云币',
      enabled: true,
    },
  ]
  let GIFT_PACKAGE = this.subTasks.filter(task => task.taskCode == 'giftPackage')[0]
  let DAILY_CHECK_IN = this.subTasks.filter(task => task.taskCode == 'dailyCheckIn')[0]
  let DAILY_WATCH_VIDEO = this.subTasks.filter(task => task.taskCode == 'dailyWatchVideo')[0]
  let OPEN_BOX = this.subTasks.filter(task => task.taskCode == 'openBox')[0]

  // 单广告最大等待秒数，避免异常广告卡死
  const MAX_AD_SECONDS = 120
  // 单次任务总超时（MainExecutor 单任务超时10分钟，这里留出余量）
  const MAX_TOTAL_SECONDS = 8.5 * 60

  this.startTime = null

  /**
   * 入口
   */
  this.exec = function () {
    this.startTime = new Date().getTime()
    // 每次执行重置广告轮次计数（决定两次广告间隔是否需要等待）
    this._adCount = 0
    this.pushLog('===== 云宝宝看广告开始 =====')
    if (!this.openYunbaobao()) {
      this.pushErrorLog('打开云宝宝失败，终止本次执行')
      return
    }
    this.skipDialogIfPresent()
    sleep(1000)
    // 进入赚云币页面（失败则终止，避免在错误页面空找）
    if (!this.enterCoinPage()) {
      this.pushErrorLog('未能进入赚云币页，终止本次执行')
      return
    }
    // 依次执行各广告任务（测试界面可通过 onlySubTask 指定只跑某个子任务，日常执行时为空=全部执行）
    let only = this.onlySubTask
    if (!only || only == 'giftPackage') {
      this.doGiftPackage()
    }
    if (!only || only == 'openBox') {
      this.doOpenBox()
    }
    if (!only || only == 'dailyCheckIn') {
      this.doDailyCheckIn()
    }
    if (!only || only == 'dailyWatchVideo') {
      this.doDailyWatchVideo()
    }
    sleep(1000)
    if (this.allSubTasksDone()) {
      this.pushLog('===== 云宝宝看广告全部完成 =====')
      this.setExecuted()
    } else {
      this.pushWarningLog('存在未完成的子任务，稍后由框架自动重试')
    }
    commonFunctions.minimize(_package_name)
  }

  this.allSubTasksDone = function () {
    return this.subTasks.filter(task => task.enabled !== false).every(task => this.isSubTaskExecuted(task, true))
  }

  this.isTimeout = function () {
    if (!this.startTime) {
      return false
    }
    return new Date().getTime() - this.startTime > MAX_TOTAL_SECONDS * 1000
  }

  /**
   * 真正关闭云宝宝：跳转「应用信息」页 → 点「结束运行 / 强行停止」→ 确定 → 返回
   * （最小化只是回桌面，进程与界面还在，重开只会恢复上次残留的页面）
   * @returns {boolean} 是否点了关闭按钮
   */
  this.closeYunbaobaoApp = function () {
    return this.forceStopByAppSettings()
  }

  /**
   * 通过系统「应用信息」页点击「结束运行 / 强行停止」关闭云宝宝（无 root 可用）
   * 流程：打开应用详情页 → 循环查找按钮 → 点击 → 循环查找「确定」确认 → 返回桌面
   * @returns {boolean} 是否点了关闭按钮
   */
  this.forceStopByAppSettings = function () {
    let backSafely = function () {
      try {
        automator.back()
      } catch (e) {
        // 忽略
      }
    }
    try {
      this.pushLog('打开云宝宝应用信息页，准备强制停止')
      app.openAppSetting(_package_name)
      sleep(1500)
      let buttonNames = ['结束运行', '强行停止', '强制停止', '停止运行']
      let btn = null
      let findBtn = function () {
        for (let i = 0; i < buttonNames.length; i++) {
          if (text(buttonNames[i]).exists()) {
            return text(buttonNames[i]).findOnce()
          }
        }
        return null
      }
      // 首屏查找（最多 5 秒）
      let start = new Date().getTime()
      while (!btn && new Date().getTime() - start < 5000) {
        btn = findBtn()
        if (!btn) {
          sleep(300)
        }
      }
      // 首屏没有就滚动一屏再找（有的机型按钮在页面下方）
      if (!btn) {
        let sv = scrollable().findOnce()
        if (sv) {
          sv.scrollForward()
        }
        sleep(800)
        start = new Date().getTime()
        while (!btn && new Date().getTime() - start < 5000) {
          btn = findBtn()
          if (!btn) {
            sleep(300)
          }
        }
      }
      if (!btn) {
        this.pushWarningLog('应用信息页未找到「结束运行/强行停止」按钮')
        this.logVisibleTexts('应用信息页')
        backSafely()
        return false
      }
      this.pushLog('点击「' + btn.text() + '」')
      if (btn.clickable()) {
        btn.click()
      } else {
        let parent = btn.parent()
        if (parent) {
          parent.click()
        } else {
          btn.click()
        }
      }
      sleep(800)
      // 处理确认弹窗（最多等 5 秒）
      let confirmNames = ['确定', '强行停止', '确定停止', '停止']
      let confirm = null
      start = new Date().getTime()
      while (!confirm && new Date().getTime() - start < 5000) {
        for (let i = 0; i < confirmNames.length; i++) {
          if (text(confirmNames[i]).exists()) {
            confirm = text(confirmNames[i]).findOnce()
            break
          }
        }
        if (!confirm) {
          sleep(300)
        }
      }
      if (confirm) {
        this.pushLog('确认弹窗点击「' + confirm.text() + '」')
        if (confirm.clickable()) {
          confirm.click()
        } else {
          let parent = confirm.parent()
          if (parent) {
            parent.click()
          } else {
            confirm.click()
          }
        }
        sleep(800)
      }
      this.pushLog('已执行「' + btn.text() + '」关闭云宝宝')
      backSafely()
      sleep(700)
      return true
    } catch (e) {
      this.pushWarningLog('应用信息页关闭云宝宝异常：' + e)
      backSafely()
      return false
    }
  }

  /**
   * 打印当前页面可见文本（诊断用：找不到按钮时把页面文案写进日志）
   * @param {string} tag 来源标记
   */
  this.logVisibleTexts = function (tag) {
    try {
      let nodes = className('android.widget.TextView').find()
      let texts = []
      nodes.forEach(function (n) {
        try {
          let t = n.text()
          if (t && texts.indexOf(t) < 0) {
            texts.push(t)
          }
        } catch (e) {
          // 单个控件读取失败忽略
        }
      })
      this.pushLog(tag + ' 可见文本（前25条）：' + texts.slice(0, 25).join(' | '))
    } catch (e) {
      logUtils.debugInfo(['打印 {} 页面文本失败：{}', tag, e])
    }
  }

  this.openYunbaobao = function () {
    this.pushLog('打开云宝宝（先关闭进程，再启动）')
    // 无条件先关闭：脚本多半是从桌面启动的，此时云宝宝在后台但进程还在，
    // 不先停掉的话 launchPackage 只会把上次的残留界面（广告页/内页）拉回前台
    this.closeYunbaobaoApp()
    sleep(1000)
    return this.launchYunbaobaoAndWaitHome()
  }

  /**
   * 启动云宝宝并等待主页锚点出现
   * @returns {boolean} 是否进入主页
   */
  this.launchYunbaobaoAndWaitHome = function () {
    try {
      commonFunctions.launchPackage(_package_name)
    } catch (e) {
      this.pushWarningLog('按包名启动异常：' + _package_name + ' ' + e)
    }
    sleep(2000)
    if (commonFunctions.myCurrentPackage() != _package_name) {
      this.pushWarningLog('当前包名不是 ' + _package_name + '，尝试按应用名启动：' + _app_name)
      try {
        app.launchApp(_app_name)
      } catch (e) {
        this.pushErrorLog('按应用名启动失败：' + _app_name + ' ' + e)
      }
      sleep(2000)
    }
    // 校验主页是否加载（允许打开确认弹框）
    let confirm = widgetUtils.widgetGetOne(/^打开|允许$/, 3000)
    if (confirm) {
      this.clickBtn(confirm, '打开确认')
    }
    if (widgetUtils.widgetWaiting('(首页|赚云币|我的|惊喜礼包|每日打卡)', null, 8000)) {
      this.pushLog('云宝宝主页加载成功')
      return true
    }
    this.pushWarningLog('未能确认云宝宝主页加载')
    return false
  }

  /**
   * 赚云币页面锚点：每日看视频10次 / 惊喜礼包（图片时用资源id兜底）
   */
  this.isOnCoinPage = function () {
    if (widgetUtils.widgetGetOne('(惊喜礼包|每日看视频10次)', 1200, false, true)) {
      return true
    }
    // 惊喜礼包为图片控件时无文字，用原生资源id兜底
    try {
      if (selector().idMatches('iv_treasure_box').findOne(600)) {
        return true
      }
    } catch (e) {
      logUtils.debugInfo(['isOnCoinPage id探测不可用：{}', e])
    }
    return false
  }

  /**
   * 当前是否处于广告页（倒计时 / 跳过 / 关闭 / 继续 任一迹象）
   * 用于广告流程收尾时判断真实页面状态，避免在广告未结束时就去找赚云币Tab
   */
  this.isAdPageVisible = function () {
    if (widgetUtils.widgetGetOne('(\\d+\\s*(秒|s|sec)|\\d{1,2}:\\d{1,2})', 600, false, true)) {
      return true
    }
    if (widgetUtils.widgetGetOne('(跳过|关闭|继续看视频|继续观看)', 600, false, true)) {
      return true
    }
    return false
  }

  /**
   * 确保停留在赚云币页：先清理可能的残留广告/弹窗（必要时返回云宝宝），再进入赚云币页
   * @param {String} tag 任务名（日志用）
   * @returns {boolean}
   */
  this.ensureCoinPage = function (tag) {
    if (this.isOnCoinPage()) {
      return true
    }
    this.pushLog('当前不在赚云币页' + (tag ? '（' + tag + '）' : '') + '，先清理页面状态')
    // 若当前已跳到其它应用，先返回云宝宝
    if (commonFunctions.myCurrentPackage() != _package_name) {
      this.pushLog('当前不在云宝宝，先返回')
      this.backToYunbaobao()
    }
    // 若识别到广告元素，按完整关闭流程关掉；否则只尝试关闭弹窗
    if (this.isAdPageVisible()) {
      this.pushLog('检测到残留广告页，关闭广告')
      this.closeAdIfPossible()
      sleep(1000)
    } else {
      this.closePopup()
    }
    if (this.isOnCoinPage()) {
      return true
    }
    return this.enterCoinPage()
  }

  /**
   * 点击主界面下方「赚云币」Tab，轮询确认进入赚云币页（最多尝试2次点击）
   */
  this.enterCoinPage = function () {
    if (this.isOnCoinPage()) {
      return true
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.isTimeout()) {
        return false
      }
      this.pushLog('查找 赚云币 Tab（第' + (attempt + 1) + '次）')
      let tab = widgetUtils.widgetGetOne('赚云币', 3000, false, true,
        m => m.boundsInside(0, config.device_height * 0.7, config.device_width, config.device_height))
      if (!tab) {
        this.pushWarningLog('未能找到 赚云币 Tab')
        return false
      }
      this.clickBtn(tab, '赚云币Tab')
      // 轮询确认进入赚云币页（页面加载可能较慢，最多4秒）
      for (let i = 0; i < 4; i++) {
        sleep(1000)
        if (this.isOnCoinPage()) {
          return true
        }
      }
    }
    this.pushWarningLog('点击赚云币Tab后仍未确认进入赚云币页')
    return false
  }

  /**
   * 返回赚云币页面（每日打卡/每日看视频看完广告后使用）
   */
  this.backToCoinPage = function (limit) {
    limit = limit || 5
    while (limit-- > 0 && !this.isOnCoinPage()) {
      if (this.isTimeout()) {
        return false
      }
      automator.back()
      sleep(1500)
    }
    if (this.isOnCoinPage()) {
      return true
    }
    // 兜底：可能回到了首页，重新点入赚云币页
    return this.enterCoinPage()
  }

  /**
   * 按控件中心坐标点击（图片/无文字控件也可用）
   */
  this.clickByBounds = function (target, desc) {
    if (!target) {
      return false
    }
    try {
      let b = target.bounds()
      if (!b) {
        this.pushWarningLog('目标无 bounds：' + (desc || ''))
        return false
      }
      automator.click(b.centerX(), b.centerY())
      this.pushLog('已点击 ' + (desc || '') + ' (' + b.centerX() + ',' + b.centerY() + ')')
      sleep(800)
      return true
    } catch (e) {
      this.pushWarningLog('点击失败 ' + (desc || '') + '：' + e)
      return false
    }
  }

  /**
   * 点击控件按钮（只写统一日志，不往屏幕打印悬浮文字/位置浮标）
   * 替代框架的 displayButtonAndClick
   * @returns {boolean} 是否点击成功
   */
  this.clickBtn = function (button, desc) {
    if (!button) {
      this.pushWarningLog('未找到按钮：' + (desc || ''))
      return false
    }
    try {
      if (automator.checkCenterClickable(button)) {
        automator.clickCenter(button)
        this.pushLog('已点击 ' + (desc || ''))
        sleep(800)
        return true
      }
      let b = button.bounds()
      if (b) {
        automator.click(b.centerX(), b.centerY())
        this.pushLog('已点击 ' + (desc || '') + '（bounds兜底）')
        sleep(800)
        return true
      }
    } catch (e) {
      this.pushWarningLog('点击 ' + (desc || '') + ' 失败：' + e)
      return false
    }
    this.pushWarningLog('按钮位置不可点击：' + (desc || ''))
    return false
  }

  /**
   * 是否已出现跳转迹象（已切到其它应用 / 弹出「***想要打开***」系统确认弹窗）
   * 用于判断跳转按钮点击是否生效，避免把系统弹窗当成「没点中」而重复点击
   */
  this.isJumpSuccessIndicator = function () {
    try {
      if (commonFunctions.myCurrentPackage() != _package_name) {
        return true
      }
    } catch (e) {
      // 包名获取失败时忽略
    }
    try {
      if (widgetUtils.widgetGetOne('(仅打开一次|仅此一次|总是打开)', 600, false, true)) {
        return true
      }
    } catch (e) {
      // 控件查询失败时忽略
    }
    return false
  }

  /**
   * 判断指定文案当前是否仍可见（控件整句/前8字优先，OCR 全屏文本兜底）
   * @param {String} text 锚点文案
   * @returns {boolean}
   */
  this.isTextVisibleOnScreen = function (text) {
    if (!text) {
      return false
    }
    let escapeText = function (t) {
      return (t || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    let target = text.replace(/\s+/g, '')
    let core = target.slice(0, 8)
    // 1. 控件查找：整句 / 前8字片段
    try {
      if (widgetUtils.widgetGetOne(escapeText(text), 1200, true)) {
        return true
      }
      if (core.length >= 4 && widgetUtils.widgetGetOne(escapeText(core), 800, true)) {
        return true
      }
    } catch (e) {
      logUtils.debugInfo(['锚点文案控件校验异常：{}', e])
    }
    // 2. OCR 全屏文本兜底（WebView 广告页控件取不到 text 时）
    if (!localOcrUtil.enabled) {
      return false
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return false
    }
    try {
      let finds = localOcrUtil.recognizeWithBounds(screen, null)
      if (!finds || finds.length === 0) {
        return false
      }
      let allText = finds.map(function (f) { return f.label || '' }).join('').replace(/\s+/g, '')
      if (allText.indexOf(target) >= 0) {
        return true
      }
      return core.length >= 4 && allText.indexOf(core) >= 0
    } catch (e) {
      logUtils.debugInfo(['锚点文案OCR校验异常：{}', e])
      return false
    }
  }

  /**
   * 点击跳转按钮（带「点击是否生效」校验）
   * 线路：记录点击前识别到的文案 → 点中心 → 等3秒 → 文案仍在说明没点中 →
   *       依次偏左/偏右/偏上再点，每次仍判断文案（最多重试3次，共4次点击）
   * @param {Object} btn 跳转按钮控件
   * @param {String} keyword 点击前识别到的文案（锚点）
   * @returns {boolean} 是否已生效（文案消失/已跳转/已弹系统确认弹窗）
   */
  this.clickJumpButtonWithRetry = function (btn, keyword) {
    if (!btn) {
      return false
    }
    let anchor = (keyword || '').trim()
    let canVerify = anchor.length >= 4
    let b = null
    try {
      b = btn.bounds()
    } catch (e) {
      b = null
    }
    if (!b) {
      return this.clickBtn(btn, '跳转按钮')
    }
    let width = b.width()
    let height = b.height()
    // 按钮常是整行文字，点中心可能落在文字间隙：中心 → 偏左 → 偏右 → 偏上
    let offsets = [
      { name: '中心', dx: 0, dy: 0 },
      { name: '偏左', dx: -0.28, dy: 0 },
      { name: '偏右', dx: 0.28, dy: 0 },
      { name: '偏上', dx: 0, dy: -0.3 }
    ]
    for (let attempt = 0; attempt < offsets.length; attempt++) {
      if (this.isTimeout()) {
        return false
      }
      let off = offsets[attempt]
      let x = Math.round(b.centerX() + width * off.dx)
      let y = Math.round(b.centerY() + height * off.dy)
      this.pushLog('点击跳转按钮（' + off.name + '）第' + (attempt + 1) + '次：' + x + ',' + y
        + (canVerify ? ' 锚点文案：' + anchor : ''))
      try {
        automator.click(x, y)
      } catch (e) {
        this.pushWarningLog('跳转按钮坐标点击失败：' + e)
        continue
      }
      sleep(3000)
      // 已切到其它应用 / 弹出「仅打开一次」系统弹窗：点击已生效
      if (this.isJumpSuccessIndicator()) {
        this.pushLog('检测到跳转迹象（系统弹窗/已切换应用），判定点击生效')
        return true
      }
      if (!canVerify) {
        return true
      }
      if (!this.isTextVisibleOnScreen(anchor)) {
        this.pushLog('锚点文案已消失，判定跳转点击生效')
        return true
      }
      this.pushWarningLog('锚点文案仍在页面，判定第' + (attempt + 1) + '次点击未生效')
    }
    this.pushWarningLog('跳转按钮连续' + offsets.length + '次点击均未生效')
    return false
  }

  /**
   * 处理启动后可能出现的「允许/跳过/下次再说」弹窗
   * （替代框架 awaitAndSkip，只写统一日志，不往屏幕打印悬浮文字）
   */
  this.skipDialogIfPresent = function () {
    let checkingList = ['\\s*允许\\s*', '\\s*跳过\\s*', '\\s*下次再说\\s*']
    let skipped = false
    for (let i = 0; i < checkingList.length; i++) {
      let btn = widgetUtils.widgetGetOne(checkingList[i], 1500, false, true)
      if (btn) {
        if (this.clickBtn(btn, '弹窗按钮' + checkingList[i])) {
          skipped = true
        }
      }
    }
    return skipped
  }

  /**
   * OCR 查找文本并可选点击（只写统一日志，不往屏幕打印悬浮文字/位置浮标）
   * @param {string|RegExp} regex 匹配文本
   * @param {string} desc 描述（日志用）
   * @param {Array} region 区域 [x, y, width, height]
   * @param {boolean} clickIt 是否点击第一个命中
   * @returns {Object|null} 兼容 clickByBounds 的对象（bounds 提供 centerX/centerY）
   */
  this.ocrFind = function (regex, desc, region, clickIt) {
    if (!localOcrUtil.enabled) {
      return null
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return null
    }
    let finds = null
    try {
      finds = localOcrUtil.recognizeWithBounds(screen, region, regex)
    } catch (e) {
      logUtils.debugInfo(['OCR识别异常（' + desc + '）：{}', e])
    }
    if (!finds || finds.length === 0) {
      return null
    }
    let bounds = finds[0].bounds
    this.pushLog('OCR识别到「' + desc + '」：' + finds[0].label)
    if (clickIt) {
      automator.click(bounds.centerX(), bounds.centerY())
      sleep(800)
    }
    return {
      bounds: () => bounds
    }
  }

  /**
   * OCR 获取区域文本（只写统一日志，不往屏幕打印悬浮文字）
   * @returns {string|null}
   */
  this.ocrGetText = function (desc, region) {
    if (!localOcrUtil.enabled) {
      return null
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return null
    }
    let finds = null
    try {
      finds = localOcrUtil.recognizeWithBounds(screen, region)
    } catch (e) {
      logUtils.debugInfo(['OCR获取文本异常（' + desc + '）：{}', e])
    }
    if (!finds || finds.length === 0) {
      return null
    }
    return finds.map(v => v.label).join('')
  }

  /**
   * 跳转应用时可能出现系统确认弹窗「***想要打开***」，点击「仅打开一次」（固定文案）
   * @param {Boolean} quick 等待循环内高频调用时传 true（仅做一次快速探测）
   */
  this.confirmJumpDialogIfNeeded = function (quick) {
    try {
      let btn = selector().text('仅打开一次').findOne(quick ? 800 : 1500)
      if (btn && automator.checkCenterClickable(btn)) {
        this.pushLog('点击 仅打开一次（跳转确认弹窗）')
        automator.clickCenter(btn)
        sleep(800)
        return true
      }
      if (!quick) {
        btn = widgetUtils.widgetGetOne('^仅打开一次$', 1000, false, true)
        if (btn && automator.checkCenterClickable(btn)) {
          this.pushLog('点击 仅打开一次（跳转确认弹窗）')
          automator.clickCenter(btn)
          sleep(800)
          return true
        }
      }
    } catch (e) {
      logUtils.debugInfo(['confirmJumpDialog 不可用：{}', e])
    }
    return false
  }

  /**
   * 广告过程中点击「继续看视频」类元素：留在应用内看完，能不跳转就不跳转
   * @param {Boolean} widgetOnly 仅控件查找（循环内高频调用）；false 时额外走OCR兜底
   */
  this.clickContinueAdIfPresent = function (widgetOnly) {
    let sources = CONTINUE_AD_CASES.map(c => c.regex.source).join('|')
    if (sources) {
      // 控件查找：可点击节点优先
      let list = widgetUtils.widgetGetAll(sources, 600, false, m => m.clickable())
      if (list && list.length > 0) {
        for (let i = 0; i < list.length; i++) {
          let text = ''
          try {
            text = (list[i].text && list[i].text()) || (list[i].desc && list[i].desc()) || ''
          } catch (e) {
            text = ''
          }
          if (isContinueAdText(text)) {
            return this.clickContinueTarget(list[i], text)
          }
        }
      }
      // 控件查找：任意节点兜底（部分广告按钮不在可点击节点上）
      let list2 = widgetUtils.widgetGetAll(sources, 400, false)
      if (list2 && list2.length > 0) {
        for (let i = 0; i < list2.length; i++) {
          let text = ''
          try {
            text = (list2[i].text && list2[i].text()) || (list2[i].desc && list2[i].desc()) || ''
          } catch (e) {
            text = ''
          }
          if (isContinueAdText(text)) {
            return this.clickContinueTarget(list2[i], text)
          }
        }
      }
    }
    // OCR 兜底（WebView 广告控件不可见）
    if (!widgetOnly && localOcrUtil.enabled) {
      let screen = commonFunctions.captureScreen()
      if (screen) {
        let finds = null
        try {
          // region 为 [x, y, width, height]，y+height 必须小于屏幕高度
          finds = localOcrUtil.recognizeWithBounds(screen, [0, Math.floor(config.device_height * 0.1), config.device_width, Math.floor(config.device_height * 0.8)])
        } catch (e) {
          logUtils.debugInfo(['OCR识别异常（继续看视频），跳过：{}', e])
        }
        return this.clickContinueByFinds(finds)
      }
    }
    return false
  }

  /**
   * 点击「继续」目标控件（同一元素只点一次，按坐标去重）
   */
  this.clickContinueTarget = function (btn, content) {
    try {
      let b = btn.bounds()
      if (!b) {
        return false
      }
      let key = Math.round(b.centerX() / 30) + '_' + Math.round(b.centerY() / 30)
      if (this._continueClicked && this._continueClicked[key]) {
        return false
      }
      if (!this._continueClicked) {
        this._continueClicked = {}
      }
      this.pushLog('点击「继续」留在应用内看广告：' + (content || ''))
      automator.click(b.centerX(), b.centerY())
      sleep(600)
      this._continueClicked[key] = true
      return true
    } catch (e) {
      this.pushWarningLog('点击继续失败：' + e)
      return false
    }
  }

  /**
   * 对OCR识别结果中的「继续」文案执行点击（waitForAdPage OCR通道复用）
   */
  this.clickContinueByFinds = function (finds) {
    if (!finds) {
      return false
    }
    for (let i = 0; i < finds.length; i++) {
      let label = finds[i].label || ''
      if (isContinueAdText(label) && finds[i].bounds) {
        if (this.clickContinueTarget({ bounds: () => finds[i].bounds }, label)) {
          return true
        }
      }
    }
    return false
  }

  /**
   * 分层查找赚云币页入口：原生idMatches -> 原生id精确 -> 框架widgetGetById -> 文本 -> OCR
   * @param {String} idShort 短资源id（如 iv_treasure_box）
   * @param {String} fullId 完整资源id（如 com.babystar.enhanced:id/iv_treasure_box）
   * @param {String} text 显示文案
   * @param {String} desc 描述（日志用）
   * @param {Boolean} preferBottom id 命中多个时优先取屏幕下半部的（悬浮按钮类）
   */
  this.findEntry = function (idShort, fullId, text, desc, preferBottom) {
    // 1) 原生 idMatches（与 lib/Unlock.js 同款用法）
    try {
      let el
      if (preferBottom) {
        el = selector().idMatches(idShort).filter(function (node) {
          try {
            return node.bounds() && node.bounds().centerY() > config.device_height * 0.5
          } catch (e) {
            return false
          }
        }).findOne(1500)
      } else {
        el = selector().idMatches(idShort).findOne(1500)
      }
      if (el) {
        this.pushLog('按资源id找到：' + desc)
        return el
      }
    } catch (e) {
      logUtils.debugInfo(['selector.idMatches 不可用：{}', e])
    }
    // 2) 原生 id 精确匹配（完整资源id）
    try {
      let el = selector().id(fullId).findOne(1500)
      if (el) {
        this.pushLog('按完整资源id找到：' + desc)
        return el
      }
    } catch (e) {
      logUtils.debugInfo(['selector.id 不可用：{}', e])
    }
    // 3) 框架 widgetGetById
    try {
      let el = widgetUtils.widgetGetById(idShort, 1500)
      if (el) {
        this.pushLog('框架资源id找到：' + desc)
        return el
      }
    } catch (e) {
      logUtils.debugInfo(['widgetGetById 不可用：{}', e])
    }
    // 4) 文本
    let el = widgetUtils.widgetGetOne(text, 1500, false, true)
    if (el) {
      this.pushLog('按文本找到：' + desc)
      return el
    }
    // 5) OCR（图片/WebView 渲染的标签）
    if (localOcrUtil.enabled) {
      let find = this.ocrFind(text, desc, null, false)
      if (find) {
        this.pushLog('按OCR找到：' + desc)
        return find
      }
    }
    return null
  }

  /**
   * 查找入口，找不到且确认在赚云币页时，下滑一屏后重试（部分入口需滚动才可见）
   */
  this.findEntryWithScroll = function (idShort, fullId, text, desc, preferBottom) {
    let el = this.findEntry(idShort, fullId, text, desc, preferBottom)
    if (el) {
      return el
    }
    if (this.isOnCoinPage()) {
      this.pushLog('首次未找到，下滑一屏后重试：' + desc)
      try {
        automator.swipe(config.device_width / 2, config.device_height * 0.6, config.device_width / 2, config.device_height * 0.3, 600)
        sleep(1500)
      } catch (e) {
        logUtils.debugInfo(['下滑失败：{}', e])
      }
      return this.findEntry(idShort, fullId, text, desc, preferBottom)
    }
    return null
  }

  /**
   * 任务：惊喜礼包（弹窗 -> 观看视频后开启 -> 看广告）
   */
  this.doGiftPackage = function () {
    if (!config.is_test && this.isSubTaskExecuted(GIFT_PACKAGE)) {
      this.pushLog('惊喜礼包已完成，跳过')
      return true
    }
    if (this.isTimeout()) {
      return false
    }
    // 确保仍在赚云币页（上一任务的广告可能未完全关闭）
    if (!this.ensureCoinPage('惊喜礼包')) {
      this.pushWarningLog('不在赚云币页且进入失败')
      return false
    }
    this.pushLog('查找 惊喜礼包')
    // 惊喜礼包是图片控件：原生id/框架id/文本/OCR 多层识别，找不到时下滑重试
    let gift = this.findEntryWithScroll('iv_treasure_box', 'com.babystar.enhanced:id/iv_treasure_box', '惊喜礼包', '惊喜礼包', false)
    if (!gift) {
      this.pushWarningLog('未找到 惊喜礼包（当前包：' + commonFunctions.myCurrentPackage() + '，赚云币页：' + this.isOnCoinPage() + '）')
      return false
    }
    if (!this.clickByBounds(gift, '惊喜礼包')) {
      this.pushWarningLog('未找到 惊喜礼包')
      return false
    }
    sleep(1200)
    // 惊喜礼包弹窗：点「观看视频后开启」看一次广告即完成
    // （不再循环看广告并用云币数 tv_points_total 判断是否增加，该控件真机获取不到已废弃）
    let openBtn = widgetUtils.widgetGetOne('观看视频.{0,6}开启|看视频.{0,6}开启|观看广告.{0,6}开启', 3000)
    if (!openBtn) {
      this.pushWarningLog('未出现「观看视频后开启」按钮')
      this.closePopup()
      this.setSubTaskExecuted(GIFT_PACKAGE)
      return true
    }
    if (!this.clickBtn(openBtn, '观看视频后开启')) {
      this.pushWarningLog('「观看视频后开启」点击失败')
      this.closePopup()
      this.setSubTaskExecuted(GIFT_PACKAGE)
      return true
    }
    this.watchAd('惊喜礼包')
    // 收尾：广告若仍未关闭，按完整关闭流程关掉，避免残留广告页影响后续任务
    if (this.isAdPageVisible()) {
      this.pushLog('广告结束后仍有广告页迹象，执行关闭')
      this.closeAdIfPossible()
    }
    this.closePopup()
    this.setSubTaskExecuted(GIFT_PACKAGE)
    return true
  }

  /**
   * 任务：开宝箱赚云币（与惊喜礼包一致）
   */
  this.doOpenBox = function () {
    if (!config.is_test && this.isSubTaskExecuted(OPEN_BOX)) {
      this.pushLog('开宝箱赚云币已完成，跳过')
      return true
    }
    if (this.isTimeout()) {
      return false
    }
    // 确保仍在赚云币页（上一任务的广告可能未完全关闭）
    if (!this.ensureCoinPage('开宝箱')) {
      this.pushWarningLog('不在赚云币页且进入失败')
      return false
    }
    this.pushLog('查找 开宝箱赚云币')
    // 开宝箱是图片控件（悬浮按钮）：优先下半屏id匹配，文本/OCR兜底
    let box = this.findEntryWithScroll('cl_bg', 'com.babystar.enhanced:id/cl_bg', '开宝箱赚云币', '开宝箱赚云币', true)
    if (!box) {
      this.pushWarningLog('未找到 开宝箱赚云币（当前包：' + commonFunctions.myCurrentPackage() + '，赚云币页：' + this.isOnCoinPage() + '）')
      return false
    }
    if (this.clickByBounds(box, '开宝箱赚云币')) {
      sleep(1200)
      let openBtn = widgetUtils.widgetGetOne('观看视频.{0,6}开启|看视频.{0,6}开启|观看广告.{0,6}开启', 3000)
      if (this.clickBtn(openBtn, '观看视频后开启')) {
        this.watchAd('开宝箱')
        // 收尾：广告若仍未关闭，按完整关闭流程关掉
        if (this.isAdPageVisible()) {
          this.pushLog('广告结束后仍有广告页迹象，执行关闭')
          this.closeAdIfPossible()
        }
        this.closePopup()
        this.setSubTaskExecuted(OPEN_BOX)
        return true
      }
      this.pushWarningLog('开宝箱未出现「观看视频后开启」按钮，尝试关闭弹窗')
      this.closePopup()
      return false
    }
    this.pushWarningLog('未找到 开宝箱赚云币')
    return false
  }

  /**
   * 判断是否在每日打卡页（出现看视频入口文案）
   */
  /**
   * 判断是否在每日打卡页（该页面标题为「按时吃饭」，返回控件 tv_back_up）
   * 优先用返回控件 id / 标题文本，再兜底看视频按钮文案
   */
  this.isOnCheckInPage = function () {
    try {
      if (selector().id('com.babystar.enhanced:id/tv_back_up').findOne(600)) {
        return true
      }
    } catch (e) {
      logUtils.debugInfo(['selector.id tv_back_up 不可用：{}', e])
    }
    if (widgetUtils.widgetGetOne('按时吃饭', 600, false, true)) {
      return true
    }
    return !!widgetUtils.widgetGetOne('看.{0,4}次视频补领|看视频.{0,8}(领|补领)', 600, false, true)
  }

  /**
   * 从赚云币页进入每日打卡页
   */
  this.enterCheckInPage = function () {
    let checkIn = widgetUtils.widgetGetOne('每日打卡', 2500)
    return this.clickByBounds(checkIn, '每日打卡')
  }

  /**
   * 点击入口后判断广告是否已开始：
   * 跳转到其它应用 = 已开始；不在按时吃饭页（原页面）= 已开始；仍在原页面 = 没点进去
   */
  this.isAdStartedAfterClick = function () {
    if (this.isTimeout()) {
      return false
    }
    if (commonFunctions.myCurrentPackage() != _package_name) {
      return true
    }
    return !this.isOnCheckInPage()
  }

  /**
   * 任务：每日打卡（进入打卡页 -> 三个看视频入口全部点一遍 -> 有广告则看完 -> 返回）
   * 打卡页有「看视频，领***」「看N次视频补领」「看视频领取」三个入口，
   * 已领取时点击无反应且无法判断是否点过，故全部点一遍
   */
  this.doDailyCheckIn = function () {
    if (!config.is_test && this.isSubTaskExecuted(DAILY_CHECK_IN)) {
      this.pushLog('每日打卡已完成，跳过')
      return true
    }
    if (this.isTimeout()) {
      return false
    }
    this.pushLog('进入 每日打卡')
    // 确保在赚云币页再进打卡页（上一任务的广告可能未完全关闭）
    if (!this.ensureCoinPage('每日打卡')) {
      this.pushWarningLog('不在赚云币页且进入失败')
      return false
    }
    if (!this.enterCheckInPage()) {
      this.pushWarningLog('未找到 每日打卡')
      return false
    }
    sleep(1500)
    // 打卡页看视频入口文案（按出现顺序全部点一遍）：
    // 「看视频，领 **」「看次视频补领」「看视频领取」——前两类可能有多个位置
    let patterns = [
      { regex: '看.{0,4}次视频补领', name: '看次视频补领' },
      { regex: '看视频.{0,8}(领|补领)', name: '看视频领奖励' },
    ]
    let attempted = {}
    let clicked = 0
    for (let i = 0; i < patterns.length; i++) {
      if (this.isTimeout()) {
        break
      }
      // 每个入口点击前确保仍在打卡页（广告看完后可能回到赚云币页）
      if (!this.isOnCheckInPage()) {
        this.pushLog('已离开打卡页，重新进入')
        if (!this.backToCoinPage()) {
          break
        }
        if (!this.enterCheckInPage()) {
          break
        }
        sleep(1200)
      }
      let list = widgetUtils.widgetGetAll(patterns[i].regex, 1500, false)
      if (!list || list.length == 0) {
        this.pushLog('打卡页未找到入口：' + patterns[i].name)
        continue
      }
      for (let j = 0; j < list.length; j++) {
        if (this.isTimeout()) {
          break
        }
        try {
          let b = list[j].bounds()
          // 按坐标去重，避免父/子控件重复点同一入口
          let key = Math.round(b.centerX() / 30) + '_' + Math.round(b.centerY() / 30)
          if (attempted[key]) {
            continue
          }
          attempted[key] = true
        } catch (e) {
          continue
        }
        let ok = false
        try {
          ok = this.clickByBounds(list[j], patterns[i].name)
        } catch (e) {
          logUtils.debugInfo(['打卡入口点击异常：{}', e])
          ok = false
        }
        if (!ok) {
          this.pushLog('入口点击失败，继续下一个：' + patterns[i].name)
          continue
        }
        clicked++
        // 点击后判断是否还在原页面（按时吃饭页）：不在 = 去看广告了；还在 = 没点进去，继续遍历下一个
        sleep(1500)
        if (this.isAdStartedAfterClick()) {
          this.watchAd('每日打卡-' + patterns[i].name)
        } else {
          this.pushLog('入口点击后仍在按时吃饭页（可能已领取），继续下一个：' + patterns[i].name)
        }
        sleep(800)
      }
    }
    this.backToCoinPage()
    if (clicked > 0) {
      this.setSubTaskExecuted(DAILY_CHECK_IN)
      return true
    }
    this.pushWarningLog('每日打卡未点中任何入口，不标记完成')
    return false
  }

  /**
   * 任务：每日看视频10次（点击文字右侧「进行中」按钮直接看广告，可重复，最多10次）
   */
  this.doDailyWatchVideo = function () {
    if (!config.is_test && this.isSubTaskExecuted(DAILY_WATCH_VIDEO)) {
      this.pushLog('每日看视频10次已完成，跳过')
      return true
    }
    if (this.isTimeout()) {
      return false
    }
    // 确保在赚云币页（上一任务的广告可能未完全关闭）
    if (!this.ensureCoinPage('每日看视频')) {
      this.pushWarningLog('不在赚云币页且进入失败')
      return false
    }
    let maxWatch = 10
    let watched = 0
    while (watched < maxWatch) {
      if (this.isTimeout()) {
        this.pushWarningLog('执行超时，结束每日看视频')
        break
      }
      let progressBtn = this.findProgressBtn()
      if (!progressBtn) {
        this.pushLog('未找到 每日看视频10次 的 进行中 按钮（可能已完成或入口消失）')
        break
      }
      watched++
      this.pushLog('每日看视频 第' + watched + '次')
      if (!this.clickBtn(progressBtn, '进行中-看视频')) {
        this.pushWarningLog('进行中 按钮点击失败，结束每日看视频')
        break
      }
      this.watchAd('每日看视频')
      // 看完后回到赚云币页，准备下一次（残留广告先关闭再回）
      if (!this.ensureCoinPage('每日看视频-回页')) {
        this.pushWarningLog('返回赚云币页失败，结束每日看视频')
        break
      }
    }
    if (watched > 0) {
      this.setSubTaskExecuted(DAILY_WATCH_VIDEO)
      return true
    }
    this.pushWarningLog('每日看视频未执行到任何一次，不标记完成')
    return false
  }

  /**
   * 查找「每日看视频10次」文字右侧的「进行中」按钮
   */
  this.findProgressBtn = function () {
    let title = widgetUtils.widgetGetOne('每日看视频10次', 1500)
    if (!title) {
      return null
    }
    let container = title.parent()
    if (!container) {
      return null
    }
    let btn = widgetUtils.subWidgetGetOne(container, '^进行中$', 1500)
    if (btn) {
      return btn
    }
    // 兜底：右侧按钮可能是「去观看 / 立即观看」等变体
    btn = widgetUtils.subWidgetGetOne(container, '(去观看|立即观看|去完成)', 1000)
    return btn
  }

  /**
   * 观看一个广告直至结束
   * 广告结束返回后，若奖励弹窗下方还有「观看视频」按钮，会点击并继续观看下一条广告
   * （最多连续 4 轮，防止死循环）
   */
  this.watchAd = function (desc) {
    // 两次广告间随机间隔：放在「进入下一条广告之前」，先打印再等待
    if (this._adCount && this._adCount > 0) {
      this.waitBetweenAds()
    }
    let maxRounds = 4
    let result = true
    for (let round = 0; round < maxRounds; round++) {
      this._needNextAd = false
      result = this.watchOneAdRound(round === 0 ? desc : desc + '(续' + round + ')')
      if (!this._needNextAd || this.isTimeout()) {
        break
      }
      this.pushLog('奖励弹窗下方还有「观看视频」，继续观看下一条广告')
    }
    this._needNextAd = false
    return result
  }

  /**
   * 观看单轮广告
   */
  this.watchOneAdRound = function (desc) {
    this._adCount = (this._adCount || 0) + 1
    this.pushLog('开始观看广告：' + desc)
    // 每次观看广告重置「继续」点击去重记录
    this._continueClicked = {}
    // 广告进入后先延时等待页面加载完成，避免把广告前页面误识别为广告元素
    sleep(3000)
    // 等待广告页加载完成（控件 + OCR 双通道）
    let adInfo = this.waitForAdPage(8)
    let result = false
    if (adInfo) {
      if (adInfo.jumpBtn) {
        result = this.watchJumpAd(adInfo.jumpBtn, desc)
      } else {
        result = this.watchCountdownAd(desc)
      }
    } else if (commonFunctions.myCurrentPackage() != _package_name) {
      // 未能识别广告页：若已跳转其它应用，按跳转广告处理
      this.pushLog('广告已跳转其它应用，按跳转领取处理')
      // 跳转时可能出现系统确认弹窗「***想要打开***」，点击 仅打开一次
      this.confirmJumpDialogIfNeeded()
      let t = this.readAdCountdown()
      let wait = (t && t > 0 ? t : 15) + 5 + Math.floor(Math.random() * 6)
      if (wait > MAX_AD_SECONDS) {
        wait = MAX_AD_SECONDS
      }
      this.waitAndLog(wait, '已跳转领取')
      this.backToYunbaobao()
      this.claimRewardIfPossible()
      this.closeAdIfPossible()
      result = true
    } else {
      // 未能识别广告页：先判断真实页面状态，避免广告还没结束/没关闭就收尾，导致后续任务在错误页面找赚云币Tab
      this.pushWarningLog('未检测到广告页元素，先判断当前页面状态')
      if (this.isAdPageVisible()) {
        this.pushLog('识别到广告页迹象，按完整关闭流程关闭广告')
        this.closeAdIfPossible()
        result = true
      } else if (this.isOnCoinPage() || this.isOnGiftDialog()) {
        this.pushLog('已在赚云币页/礼包弹窗且无广告元素，本轮结束')
        result = true
      } else {
        // 页面状态不明（可能点在广告加载中）：再识别一轮，仍不行则返回云宝宝清理
        this.pushLog('页面状态不明，再等待识别广告页')
        sleep(2000)
        let adInfo2 = this.waitForAdPage(4)
        if (adInfo2) {
          if (adInfo2.jumpBtn) {
            result = this.watchJumpAd(adInfo2.jumpBtn, desc)
          } else {
            result = this.watchCountdownAd(desc)
          }
        } else {
          this.pushWarningLog('仍未识别到广告元素，返回云宝宝并清理弹窗')
          this.backToYunbaobao()
          this.claimRewardIfPossible(true)
          this.closePopup()
          result = true
        }
      }
    }
    return result
  }

  /**
   * 两次看广告之间随机等待 10-50 秒（模拟真人操作节奏，防止被识别为脚本）
   */
  this.waitBetweenAds = function () {
    let sec = 10 + Math.floor(Math.random() * 41)
    this.pushLog('两次广告间随机等待' + sec + '秒')
    let start = new Date().getTime()
    while (new Date().getTime() - start < sec * 1000) {
      if (this.isTimeout()) {
        break
      }
      sleep(1000)
    }
  }

  /**
   * 等待广告页加载完成，返回检测到的元素 { countdown, closeBtn, jumpBtn }
   * 识别优先级：继续看视频（留在应用内） > 跳转按钮 > 倒计时 > 跳过/关闭
   * —— 因为存在「上方倒计时引导文案 + 下方跳转按钮」的广告，若先识别倒计时会漏掉跳转；
   *    同时出现「继续看视频」时优先点继续，能不跳转就不跳转
   */
  this.waitForAdPage = function (limit) {
    let topRegion = m => m.boundsInside(config.device_width * 0.3, 0, config.device_width, config.device_height * 0.35)
    let topLimitY = config.device_height * 0.35
    let countdownLeftX = config.device_width * 0.3
    while (limit-- > 0) {
      if (this.isTimeout()) {
        return null
      }
      // 0) 优先点「继续看视频」留在应用内（控件快查，命中即点击并重新检测）
      if (this.clickContinueAdIfPresent(true)) {
        continue
      }
      // 1) 跳转类按钮（控件，已知文案快查）—— 优先于倒计时
      let jumpBtn = this.findJumpButtonByWidgetFast()
      if (jumpBtn) {
        return { countdown: null, closeBtn: null, jumpBtn: jumpBtn }
      }
      // 2) OCR 全屏识别：先扫「继续」文案，再找跳转文案，最后找右上角倒计时
      if (localOcrUtil.enabled) {
        let screen = commonFunctions.captureScreen()
        if (screen) {
          let finds = null
          try {
            // 注意：region 为 [x, y, width, height]，y+height 必须小于屏幕高度
            finds = localOcrUtil.recognizeWithBounds(screen, [0, Math.floor(config.device_height * 0.1), config.device_width, Math.floor(config.device_height * 0.85)])
          } catch (e) {
            logUtils.debugInfo(['OCR识别异常，降级为控件检测：{}', e])
          }
          if (finds && finds.length > 0) {
            // 2a) 继续文案优先（命中即点击，随后重新检测）
            if (this.clickContinueByFinds(finds)) {
              continue
            }
            // 2b) 跳转文案（含「去体验X秒后可拿奖励」类引导，命中即按跳转处理）
            for (let i = 0; i < finds.length; i++) {
              let label = finds[i].label || ''
              if (isJumpAdText(label)) {
                this.pushLog('OCR识别到跳转文案：' + label)
                return { countdown: null, closeBtn: null, jumpBtn: { bounds: () => finds[i].bounds, content: label } }
              }
            }
            // 2c) 右上角倒计时（限制秒数上限，防止把广告前页面的云币数等数字误读为倒计时）
            for (let i = 0; i < finds.length; i++) {
              let label = finds[i].label || ''
              if (finds[i].bounds && finds[i].bounds.centerY() <= topLimitY && finds[i].bounds.centerX() >= countdownLeftX) {
                let t = parseSeconds(label)
                if (t && t > 0 && t <= MAX_AD_SECONDS) {
                  this.pushLog('OCR识别到广告倒计时：' + label + ' => ' + t + '秒')
                  return { countdown: { bounds: () => finds[i].bounds, content: label }, closeBtn: null, jumpBtn: null }
                }
              }
            }
          }
        }
      }
      // 3) 右上角倒计时（控件）——若控件文本本身含跳转文案（如「去体验5秒后可拿奖励」），按跳转处理
      let countdown = widgetUtils.widgetGetOne('(\\d+\\s*(秒|s|sec)|\\d{1,2}:\\d{1,2})', 1000, false, true, topRegion)
      if (countdown) {
        let ctext = ''
        try {
          ctext = (countdown.text && countdown.text()) || (countdown.desc && countdown.desc()) || countdown.content || ''
        } catch (e) {
          ctext = countdown.content || ''
        }
        if (isJumpAdText(ctext)) {
          this.pushLog('控件倒计时文本含跳转文案，按跳转处理：' + ctext)
          return { countdown: null, closeBtn: null, jumpBtn: countdown }
        }
        return { countdown: countdown, closeBtn: null, jumpBtn: null }
      }
      // 4) 右上角跳过/关闭（控件）
      let closeBtn = widgetUtils.widgetGetOne('(跳过|关闭)', 1000, false, true, topRegion)
      if (closeBtn) {
        return { countdown: null, closeBtn: closeBtn, jumpBtn: null }
      }
      sleep(1000)
    }
    // 循环结束仍未确认广告元素，做一次带OCR的完整跳转按钮检测（全屏区域）
    let jumpBtn = this.findJumpButton()
    if (jumpBtn) {
      return { countdown: null, closeBtn: null, jumpBtn: jumpBtn }
    }
    return null
  }

  /**
   * 方式一：直接看满倒计时后领取并关闭
   */
  this.watchCountdownAd = function (desc) {
    let t = this.readAdCountdown()
    let wait = (t && t > 0 ? t : 15) + 8
    if (wait > MAX_AD_SECONDS) {
      wait = MAX_AD_SECONDS
    }
    this.pushLog('看满广告：倒计时约' + (t || '未知') + '秒，等待' + wait + '秒')
    // 并行监控线程：跳转类弹窗不会一开始就出现，会在不定时出现，由独立线程持续监控
    // 主进程（本函数）只负责看满倒计时并领取；监控线程只读不点，发现后通知主进程切换
    let monitor = this.startJumpMonitor(wait)
    let start = new Date().getTime()
    try {
      while (new Date().getTime() - start < wait * 1000) {
        if (this.isTimeout()) {
          break
        }
        sleep(1000)
        // 出现「领取福利/放弃福利」弹窗：选「放弃福利」（识别到继续说明可不跳转，继续看满拿奖励）
        if (this.abandonWelfareIfPresent()) {
          continue
        }
        // 监控线程发现跳转按钮 → 主进程切换为跳转领取
        if (this._jumpFound) {
          let jumpBtn = this._jumpFound
          this._jumpFound = null
          this.pushLog('并行监控发现跳转按钮，切换为跳转领取')
          return this.watchJumpAd(jumpBtn, desc)
        }
        // 监控发现「继续看视频」→ 点继续留在应用内（能不跳转就不跳转）
        if (this._continuePending) {
          this._continuePending = false
          this.clickContinueAdIfPresent(true)
          continue
        }
        // 提前检测到奖励/可领取状态则结束
        if (widgetUtils.widgetGetOne('(领取奖励|收下|确定|恭喜|奖励已发放|奖励已到账|获得.{0,8}(云币|奖励))', 600, false, true)) {
          this.pushLog('检测到奖励状态，提前结束')
          break
        }
      }
    } finally {
      this.stopJumpMonitor(monitor)
    }
    // 看满后监控可能刚发现跳转 → 优先处理跳转（跳转式弹窗常在倒计时结束时出现）
    if (this._jumpFound) {
      let jumpBtn = this._jumpFound
      this._jumpFound = null
      this.pushLog('看满后监控发现跳转按钮，切换为跳转领取')
      return this.watchJumpAd(jumpBtn, desc)
    }
    this.claimRewardIfPossible()
    this.closeAdIfPossible()
    return true
  }

  /**
   * 启动跳转监控线程：持续检测不定时出现的跳转类弹窗 / 「继续看视频」按钮
   * 监控线程只读不点击：发现跳转存入 this._jumpFound，发现「继续」置 this._continuePending，
   * 由主进程（看满倒计时）统一执行点击，避免多线程同时操作UI
   * @param {Number} waitSeconds 广告预计等待秒数（监控超时 = wait + 5）
   */
  this.startJumpMonitor = function (waitSeconds) {
    this._jumpFound = null
    this._continuePending = false
    let stopFlag = { stop: false }
    let self = this
    let thread = threads.start(function () {
      let start = new Date().getTime()
      let ocrTick = 0
      while (!stopFlag.stop && new Date().getTime() - start < (waitSeconds + 5) * 1000) {
        if (self._jumpFound) {
          break
        }
        // 1) 「继续看视频」优先：未点过的继续元素存在则通知主进程（能不跳转就不跳转）
        if (self.checkContinuePending()) {
          sleep(600)
          continue
        }
        // 2) 跳转按钮控件快查（已知文案）
        let btn = self.findJumpButtonByWidgetFast()
        if (btn) {
          self._jumpFound = btn
          break
        }
        // 3) 每3轮一次 OCR 找跳转文案（WebView 弹窗控件不可见时兜底）
        if (++ocrTick % 3 == 0) {
          let btn2 = self.findJumpButtonByOcrOnce()
          if (btn2) {
            self._jumpFound = btn2
            break
          }
        }
        sleep(1000)
      }
    })
    return { thread: thread, stop: stopFlag }
  }

  /**
   * 停止跳转监控线程
   */
  this.stopJumpMonitor = function (monitor) {
    if (monitor) {
      monitor.stop = true
      try {
        monitor.thread.interrupt()
      } catch (e) {
        logUtils.debugInfo(['监控线程停止异常：{}', e])
      }
    }
    this._continuePending = false
  }

  /**
   * 检测「继续看视频」类元素是否出现且未点过：出现则通知主进程点继续（本函数不实际点击）
   * @returns {Boolean} 是否存在待点击的继续元素
   */
  this.checkContinuePending = function () {
    let sources = CONTINUE_AD_CASES.map(c => c.regex.source).join('|')
    if (!sources) {
      return false
    }
    let list = widgetUtils.widgetGetAll(sources, 500, false, m => m.clickable())
    if (list && list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        let text = ''
        try {
          text = (list[i].text && list[i].text()) || (list[i].desc && list[i].desc()) || ''
        } catch (e) {
          text = ''
        }
        if (isContinueAdText(text)) {
          // 已点过的继续元素不再重复通知（避免一直卡在继续上、跳转永不检测）
          if (this.isContinueClicked(list[i])) {
            break
          }
          this._continuePending = true
          return true
        }
      }
    }
    let list2 = widgetUtils.widgetGetAll(sources, 300, false)
    if (list2 && list2.length > 0) {
      for (let i = 0; i < list2.length; i++) {
        let text = ''
        try {
          text = (list2[i].text && list2[i].text()) || (list2[i].desc && list2[i].desc()) || ''
        } catch (e) {
          text = ''
        }
        if (isContinueAdText(text)) {
          if (this.isContinueClicked(list2[i])) {
            break
          }
          this._continuePending = true
          return true
        }
      }
    }
    return false
  }

  /**
   * 判断「继续」元素是否已被点击过（按坐标去重键判断）
   */
  this.isContinueClicked = function (el) {
    try {
      let b = el.bounds()
      if (!b) {
        return false
      }
      let key = Math.round(b.centerX() / 30) + '_' + Math.round(b.centerY() / 30)
      return !!(this._continueClicked && this._continueClicked[key])
    } catch (e) {
      return false
    }
  }

  /**
   * 单次OCR识别跳转文案（监控线程每3轮调用一次）
   */
  this.findJumpButtonByOcrOnce = function () {
    if (!localOcrUtil.enabled) {
      return null
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return null
    }
    let finds = null
    try {
      finds = localOcrUtil.recognizeWithBounds(screen, [0, Math.floor(config.device_height * 0.1), config.device_width, Math.floor(config.device_height * 0.85)])
    } catch (e) {
      logUtils.debugInfo(['OCR识别异常（监控线程），跳过：{}', e])
      return null
    }
    if (!finds || finds.length === 0) {
      return null
    }
    for (let i = 0; i < finds.length; i++) {
      let label = finds[i].label || ''
      if (isJumpAdText(label)) {
        return { bounds: () => finds[i].bounds, content: label }
      }
    }
    return null
  }

  /**
   * 方式二：跳转类广告（我要加速领奖励 / 跳转APP领奖励 等）
   * 点击跳转 -> 等待倒计时 t + 5~10s -> 返回云宝宝 -> 领取奖励并关闭广告
   */
  this.watchJumpAd = function (jumpBtn, desc) {
    let content = ''
    try {
      content = (jumpBtn.text && jumpBtn.text()) || (jumpBtn.desc && jumpBtn.desc()) || jumpBtn.content || ''
    } catch (e) {
      content = jumpBtn.content || ''
    }
    this.pushLog('命中跳转类广告文案：' + content)
    let t = this.readAdCountdown()
    // 跳转按钮常是整行文字（如「点击打开或下载第三方应用」），点中心可能落在文字间隙点不到：
    // 点击前记录识别到的文案作为锚点，点后等3秒校验，文案还在就偏左/偏右/偏上重试（最多3次）
    let clicked = this.clickJumpButtonWithRetry(jumpBtn, content)
    if (clicked) {
      this.pushLog('跳转按钮点击已生效')
    } else {
      this.pushWarningLog('跳转按钮点击可能未生效，继续后续流程（等待期间持续复查）')
    }
    // 跳转时可能出现系统确认弹窗「***想要打开***」：弹窗不会马上出现，先等待再反复确认点击
    sleep(clicked ? 1200 : 2500)
    for (let i = 0; i < 3; i++) {
      if (this.confirmJumpDialogIfNeeded()) {
        break
      }
      sleep(1200)
    }
    // 跳转后先上下滑动屏幕，触发广告倒计时继续（部分广告跳转后倒计时会暂停）
    this.triggerCountdownBySwipe()
    // 跳转后等待 t + 5~10s
    let extra = 5 + Math.floor(Math.random() * 6)
    let wait = (t && t > 0 ? t : 15) + extra
    if (wait > MAX_AD_SECONDS) {
      wait = MAX_AD_SECONDS
    }
    this.pushLog('跳转领取中 等待' + wait + '秒')
    let loopCount = 0
    while (wait-- > 0) {
      if (this.isTimeout()) {
        break
      }
      sleep(1000)
      // 每2秒复查一次「仅打开一次」弹窗 + 检测应用商店（下载类广告）
      if (++loopCount % 2 == 0) {
        this.confirmJumpDialogIfNeeded(true)
        if (this.isDownloadStore()) {
          this.pushLog('检测到应用商店，判定为下载类广告')
          this.cancelDownloadAndClose()
          return true
        }
      }
      // 整个等待期间持续上下滑屏触发倒计时继续（每5秒一次，不在应用商店时）
      if (loopCount % 5 == 0 && !this.isDownloadStore()) {
        this.triggerCountdownBySwipe()
      }
      this.replaceLastLog('跳转领取中 剩余' + wait + '秒')
    }
    // 等待结束时再查一次（下载类广告的商店可能到得较晚）
    if (this.isDownloadStore()) {
      this.pushLog('等待结束仍停留在应用商店，判定为下载类广告')
      this.cancelDownloadAndClose()
      return true
    }
    this.confirmJumpDialogIfNeeded()
    // 返回云宝宝，并确认当前应用：若识别到不是云宝宝则直接按包名/应用名打开
    let backOk = this.backToYunbaobao()
    if (!backOk) {
      this.pushWarningLog('未能返回云宝宝，跳过领取/关闭避免在其它应用误操作')
      return false
    }
    // 跳转类广告等待期间可能已自动关闭：返回后通常是「恭喜获得」奖励弹窗（广告已关闭），
    // 不需要找关闭键；奖励下方可能还有「观看视频」按钮，必须点它继续看下一条广告，不能直接关闭
    let rewardFound = widgetUtils.widgetGetOne('恭喜.{0,6}(获得|领取|奖励)|奖励.{0,4}(已|到账)', 1000, false, true)
    if (rewardFound) {
      this.pushLog('返回后检测到「恭喜获得」奖励弹窗（广告已自动关闭）')
      if (!this.claimRewardIfPossible(true)) {
        this.pushLog('未找到领取按钮')
      }
      sleep(800)
    }
    // 奖励弹窗 / 惊喜礼包弹窗下方可能还有「观看视频」按钮：点它继续看下一条广告（不关闭弹窗）
    let nextAdBtn = this.findNextAdButton()
    if (nextAdBtn) {
      // 两次广告间隔：先等待再点击，确保间隔发生在下一条广告开始之前（不在广告里干等）
      this.waitBetweenAds()
      this.pushLog('返回后检测到「观看视频」按钮，点击继续看广告（不关闭弹窗）')
      if (this.clickBtn(nextAdBtn, '观看视频(奖励弹窗)')) {
        this._needNextAd = true
        return true
      }
      this.pushWarningLog('「观看视频」按钮点击失败，按关闭流程处理')
    }
    // 没有「观看视频」按钮：已回到礼包弹窗则关闭弹窗；否则广告未自动关闭，正常关闭广告
    if (this.isOnGiftDialog()) {
      this.pushLog('返回后停留在惊喜礼包弹窗（未发现观看视频按钮），关闭弹窗')
      this.closePopup()
    } else {
      // 广告未自动关闭，正常关闭广告（关闭后如有挽留弹窗会处理）
      this.closeAdIfPossible()
    }
    return true
  }

  /**
   * 找广告结束后奖励弹窗 / 惊喜礼包弹窗下方的「观看视频」按钮
   * （点它继续看下一条广告；区别于广告内的「继续看视频」挽留按钮）
   */
  this.findNextAdButton = function () {
    let patterns = [
      '观看视频.{0,6}(开启|领取|奖励|得)',
      '看视频.{0,6}(开启|领取|奖励|得)',
      '观看广告.{0,6}(开启|领取|奖励|得)'
    ]
    for (let i = 0; i < patterns.length; i++) {
      let btn = widgetUtils.widgetGetOne(patterns[i], i === 0 ? 1500 : 600, false, true)
      if (btn) {
        return btn
      }
    }
    return null
  }

  /**
   * 判断当前是否停留在惊喜礼包弹窗（观看视频后开启）
   */
  this.isOnGiftDialog = function () {
    return !!widgetUtils.widgetGetOne('观看视频.{0,6}开启|看视频.{0,6}开启|观看广告.{0,6}开启', 800, false, true)
  }

  /**
   * 跳转到其它App后，回到云宝宝
   * 返回后校验当前应用：识别到不是云宝宝则直接按包名打开，包名未生效再按应用名打开
   */
  this.backToYunbaobao = function () {
    let limit = 5
    while (limit-- > 0) {
      if (commonFunctions.myCurrentPackage() == _package_name) {
        sleep(1000)
        return true
      }
      this.pushLog('尝试返回云宝宝')
      commonFunctions.launchPackage(_package_name)
      sleep(2000)
      // 包名启动后再次校验当前应用；仍不是云宝宝则按应用名直接打开兜底
      if (commonFunctions.myCurrentPackage() != _package_name) {
        this.pushLog('包名启动未生效，按应用名打开云宝宝')
        try {
          app.launchApp(_app_name)
        } catch (e) {
          this.pushWarningLog('按应用名打开云宝宝异常：' + e)
        }
        sleep(2000)
      }
    }
    let final = commonFunctions.myCurrentPackage() == _package_name
    if (!final) {
      this.pushWarningLog('返回云宝宝失败（当前应用：' + commonFunctions.myCurrentPackage() + '）')
    }
    return final
  }

  /**
   * 读取广告右上角倒计时（控件优先，OCR兜底），返回秒数；识别失败返回 null
   */
  this.readAdCountdown = function () {
    let countdownRegion = [Math.floor(config.device_width * 0.4), 0, Math.floor(config.device_width * 0.6), Math.floor(config.device_height * 0.35)]
    let topRegion = m => m.boundsInside(config.device_width * 0.3, 0, config.device_width, config.device_height * 0.35)
    let countdown = widgetUtils.widgetGetOne('(\\d+\\s*(秒|s|sec)|\\d{1,2}:\\d{1,2})', 1500, true, true, topRegion)
    if (countdown && countdown.content) {
      let t = parseSeconds(countdown.content)
      if (t && t > 0) {
        this.pushLog('识别到广告倒计时(控件)：' + countdown.content + ' => ' + t + '秒')
        return t
      }
    }
    if (localOcrUtil.enabled) {
      let text = this.ocrGetText('广告倒计时', countdownRegion)
      if (text) {
        let t = parseSeconds(text)
        if (t && t > 0 && t <= MAX_AD_SECONDS) {
          this.pushLog('识别到广告倒计时(OCR)：' + text + ' => ' + t + '秒')
          return t
        }
      }
    }
    this.pushWarningLog('未能识别广告倒计时')
    return null
  }

  /**
   * 通过控件查找跳转按钮（已知文案快查，用于循环内高频调用）
   */
  this.findJumpButtonByWidgetFast = function () {
    let knownRegex = buildJumpRegex()
    if (knownRegex) {
      let list = widgetUtils.widgetGetAll(knownRegex, 800, false, m => m.clickable())
      if (list && list.length > 0) {
        for (let i = 0; i < list.length; i++) {
          let text = ''
          try {
            text = (list[i].text && list[i].text()) || (list[i].desc && list[i].desc()) || ''
          } catch (e) {
            text = ''
          }
          if (isJumpAdText(text)) {
            return list[i]
          }
        }
      }
    }
    return null
  }

  /**
   * 通过控件查找跳转按钮（已知文案快查 + 启发式兜底）
   */
  this.findJumpButtonByWidget = function () {
    // 方式一：已知文案批量查找（快，覆盖情况表）
    let btn = this.findJumpButtonByWidgetFast()
    if (btn) {
      return btn
    }
    // 方式二：selector 全量过滤（覆盖未收录的新文案）
    try {
      btn = selector().clickable().filter(node => {
        try {
          let text = (node.text && node.text()) || (node.desc && node.desc()) || ''
          return isJumpAdText(text)
        } catch (e) {
          return false
        }
      }).findOne(1500)
      if (btn) {
        return btn
      }
    } catch (e) {
      logUtils.debugInfo(['selector.filter 方式不可用：{}', e])
    }
    return null
  }

  /**
   * 查找跳转按钮：控件查找失败后，用OCR兜底（部分广告为WebView渲染，控件不可见）
   */
  this.findJumpButton = function () {
    let btn = this.findJumpButtonByWidget()
    if (btn) {
      return btn
    }
    if (localOcrUtil.enabled) {
      this.pushLog('控件未找到跳转按钮，尝试OCR')
      return this.findJumpButtonByOcrOnce()
    }
    return null
  }

  /**
   * 广告结束后，领取可能出现的奖励弹窗
   * @param {boolean} strict 严格模式：仅点击明确的领取/确认文案，避免误触其它内容
   */
  this.claimRewardIfPossible = function (strict) {
    let pattern = strict ? '(领取奖励|收下|确定|恭喜)' : '(领取奖励|领取|收下|确定|知道了|恭喜)'
    let reward = widgetUtils.widgetGetOne(pattern, 1500, false, true)
    if (reward && automator.checkCenterClickable(reward)) {
      this.pushLog('检测到奖励弹窗，点击领取')
      automator.clickCenter(reward)
      sleep(1000)
      return true
    }
    return false
  }

  /**
   * 关闭广告：依次尝试 右上角跳过/关闭 -> 全屏关闭/知道了 -> OCR右上角 -> 返回键
   */
  /**
   * 关闭广告。关闭后可能出现挽留弹窗：普通广告选「继续观看」（afterAdClosed 处理，仅一次），
   * 下载类广告（closeMode=true）直接点「关闭广告」不再继续看
   * @param {boolean} keepWatchHandled 是否已处理过挽留弹窗
   * @param {boolean} closeMode 下载类广告：直接关闭，不点继续观看
   */
  this.closeAdIfPossible = function (keepWatchHandled, closeMode) {
    let topRegion = m => m.boundsInside(config.device_width * 0.3, 0, config.device_width, config.device_height * 0.35)
    // 1) 右上角 跳过/关闭
    let btn = widgetUtils.widgetGetOne('(跳过|关闭)', 1500, false, true, topRegion)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击右上角 跳过/关闭')
      automator.clickCenter(btn)
      sleep(800)
      this.afterAdClosed(keepWatchHandled, closeMode)
      return true
    }
    // 2) 全屏 关闭/知道了
    btn = widgetUtils.widgetGetOne('(关闭|知道了|好的)', 1500, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击 关闭/知道了')
      automator.clickCenter(btn)
      sleep(800)
      this.afterAdClosed(keepWatchHandled, closeMode)
      return true
    }
    // 3) OCR 右上角
    if (localOcrUtil.enabled) {
      let find = this.ocrFind('跳过|关闭', '广告关闭按钮', [Math.floor(config.device_width * 0.3), 0, Math.floor(config.device_width * 0.7), Math.floor(config.device_height * 0.35)], true)
      if (find) {
        sleep(800)
        this.afterAdClosed(keepWatchHandled, closeMode)
        return true
      }
    }
    // 3.5) 识图右上角关闭叉（部分广告无控件且返回键无效，需模板匹配找叉）
    let tplClose = this.findCloseByTemplate()
    if (tplClose) {
      this.pushLog('识图找到右上角关闭叉，点击')
      this.clickByBounds(tplClose, '关闭叉(识图)')
      sleep(800)
      this.afterAdClosed(keepWatchHandled, closeMode)
      return true
    }
    // 4) 返回键（已回到赚云币页时不再按返回，避免误退出应用）
    if (!this.isOnCoinPage()) {
      this.pushLog('未找到关闭按钮，使用返回键')
      automator.back()
      sleep(800)
      this.afterAdClosed(keepWatchHandled, closeMode)
      return true
    }
    this.pushLog('已回到赚云币页，无需返回键关闭')
    return false
  }

  /**
   * 点击关闭广告后：处理挽留弹窗
   * - 普通广告：可能弹「再看**秒，可领取奖励 / 继续观看 / 残忍离开」-> 选「继续观看」，
   *   回到广告等待剩余倒计时结算，再领取并再次关闭（仅处理一次，避免死循环）
   * - 下载类广告（closeMode=true）：直接点「关闭广告」，不再继续看、不领取
   */
  this.afterAdClosed = function (keepWatchHandled, closeMode) {
    if (keepWatchHandled) {
      return
    }
    if (closeMode) {
      this.handleCloseAdDialog()
      return
    }
    if (!this.handleKeepWatchingDialog()) {
      return
    }
    // 点了继续观看：广告继续播放，等待剩余倒计时结算
    this.pushLog('已选「继续观看」，等待广告结算')
    let t = this.readAdCountdown()
    let wait = (t && t > 0 ? t : 10) + 3
    if (wait > MAX_AD_SECONDS) {
      wait = MAX_AD_SECONDS
    }
    let start = new Date().getTime()
    while (new Date().getTime() - start < wait * 1000) {
      if (this.isTimeout()) {
        break
      }
      sleep(1000)
      // 出现「领取福利/放弃福利」弹窗：选「放弃福利」继续看满
      if (this.abandonWelfareIfPresent()) {
        continue
      }
      if (widgetUtils.widgetGetOne('(领取奖励|收下|确定|恭喜|奖励已发放|奖励已到账|获得.{0,8}(云币|奖励))', 600, false, true)) {
        this.pushLog('检测到奖励状态，领取')
        break
      }
    }
    this.claimRewardIfPossible()
    sleep(800)
    this.closeAdIfPossible(true)
  }

  /**
   * 处理下载类广告关闭后的挽留弹窗：直接点「关闭广告」（不点继续观看）
   * @returns {boolean} 是否点了关闭广告
   */
  this.handleCloseAdDialog = function () {
    let btn = widgetUtils.widgetGetOne('^关闭广告$', 800, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击挽留弹窗「关闭广告」')
      automator.clickCenter(btn)
      sleep(800)
      return true
    }
    btn = widgetUtils.widgetGetOne('关闭广告', 600, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击「关闭广告」（模糊命中）')
      automator.clickCenter(btn)
      sleep(800)
      return true
    }
    return false
  }

  /**
   * 识图找右上角关闭叉：部分广告无关闭控件且返回键无效，必须手动点叉。
   * 模板来源（同 dingdong 方式优先）：config_data/yunbaobao/ad_close.data（base64 配置），
   * 兜底 assets/ad_close.png 模板文件；匹配区域限制在屏幕右上角（0.7w~1.0w, 0~0.3h）
   * @returns {Object|null} 可点击对象（bounds 提供 centerX/centerY），未找到或模板缺失返回 null
   */
  this.findCloseByTemplate = function () {
    // 1) 优先：config_data 里的 base64（同 dingdong 方式：config_data/yunbaobao/ad_close.data）
    let closeConfig = (config.yunbaobao_config && config.yunbaobao_config.ad_close) || ''
    if (closeConfig && closeConfig.length > 100) {
      logUtils.debugInfo(['关闭叉模板来源：config_data/yunbaobao/ad_close.data，base64长度：{}', closeConfig.length])
      return this.findImgInTopRight(closeConfig, '关闭叉')
    }
    // 2) 兜底：assets/ad_close.png 模板文件
    let tplPath = 'assets/ad_close.png'
    if (!files.exists(tplPath)) {
      try {
        tplPath = files.join(files.cwd(), 'assets', 'ad_close.png')
      } catch (e) {
        return null
      }
      if (!files.exists(tplPath)) {
        this.pushWarningLog('未找到关闭叉模板：config_data/yunbaobao/ad_close.data 或 assets/ad_close.png')
        return null
      }
    }
    let tpl = null
    try {
      logUtils.debugInfo(['关闭叉模板来源：png 文件（{}），尺寸读取中', tplPath])
      tpl = images.read(tplPath)
    } catch (e) {
      logUtils.debugInfo(['读取关闭叉模板图失败：{}', e])
      return null
    }
    if (!tpl) {
      return null
    }
    let b64 = ''
    try {
      b64 = images.toBase64(tpl)
    } catch (e) {
      logUtils.debugInfo(['模板图转base64失败：{}', e])
    }
    tpl.recycle()
    if (!b64) {
      return null
    }
    return this.findImgInTopRight(b64, '关闭叉')
  }

  /**
   * 用 base64 模板在页面识图（灰度匹配，region 为 [x, y, width, height] 语义）
   * @param {string} base64 模板图 base64
   * @param {string} desc 描述（日志用）
   */
  this.findImgInTopRight = function (base64, desc) {
    if (!base64) {
      return null
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return null
    }
    let tpl = null
    try {
      tpl = images.fromBase64(base64)
    } catch (e) {
      logUtils.debugInfo(['base64 转图失败：{}', e])
      return null
    }
    if (!tpl) {
      return null
    }
    let result = this.matchTemplateInPage(screen, tpl, desc)
    try {
      tpl.recycle()
    } catch (e) {
      // 忽略
    }
    try {
      screen.recycle()
    } catch (e) {
      // 忽略
    }
    return result
  }

  /**
   * 灰度多尺度模板匹配（修复「明明有叉却找不到」的三类原因）：
   * ① 原图灰度 + 彩色模板混合比较 → 相似度虚低：这里两边统一转灰度
   * ② 模板与真机截屏分辨率不同（叉的大小不一致）→ 逐一试 1.0 / 0.85 / 1.15 三种尺度
   * ③ 叉不在右上角 0.3 高范围内 → 区域分级：右上角 0.4w×0.35h → 上半屏右侧 → 全屏（仅高阈值）
   * 总耗时受 6 秒预算保护，避免广告页反复识图拖慢流程
   * @param {Object} screen 屏幕截图
   * @param {Object} tpl 模板图
   * @param {string} desc 描述
   * @returns {Object|null} 命中时返回带 bounds 的可点击对象
   */
  this.matchTemplateInPage = function (screen, tpl, desc) {
    let sw = screen.getWidth()
    let sh = screen.getHeight()
    let tw = tpl.getWidth()
    let th = tpl.getHeight()
    let startTime = new Date().getTime()
    let budget = 6000
    let thresholds = [0.8, 0.72, 0.65]
    let scales = [1, 0.85, 1.15]
    let regions = [
      [Math.floor(sw * 0.6), 0, Math.floor(sw * 0.4), Math.floor(sh * 0.35)],
      [Math.floor(sw * 0.5), 0, Math.floor(sw * 0.5), Math.floor(sh * 0.5)]
    ]
    let grayScreen = null
    let tplVariants = []
    let point = null
    try {
      grayScreen = images.cvtColor(images.grayscale(screen), 'GRAY2BGRA')
      scales.forEach(function (s) {
        let g = images.grayscale(tpl)
        if (s !== 1) {
          g = images.resize(g, Math.round(tw * s), Math.round(th * s))
        }
        tplVariants.push({ scale: s, img: images.cvtColor(g, 'GRAY2BGRA') })
      })
      let done = false
      for (let i = 0; i < regions.length && !done; i++) {
        let region = regions[i]
        if (region[0] + region[2] > sw) {
          region[2] = sw - region[0]
        }
        if (region[1] + region[3] > sh) {
          region[3] = sh - region[1]
        }
        for (let vi = 0; vi < tplVariants.length && !done; vi++) {
          let variant = tplVariants[vi]
          let vw = variant.img.getWidth()
          let vh = variant.img.getHeight()
          if (region[2] <= vw || region[3] <= vh) {
            continue
          }
          for (let ti = 0; ti < thresholds.length && !done; ti++) {
            if (new Date().getTime() - startTime > budget) {
              done = true
              break
            }
            try {
              let p = images.findImage(grayScreen, variant.img, { threshold: thresholds[ti], region: region })
              if (p) {
                point = {
                  x: p.x,
                  y: p.y,
                  w: vw,
                  h: vh,
                  scale: variant.scale,
                  threshold: thresholds[ti],
                  regionIndex: i + 1,
                  cost: new Date().getTime() - startTime
                }
                done = true
              }
            } catch (e) {
              logUtils.debugInfo(['识图匹配异常（区域{}/尺度{}/阈值{}）：{}', i + 1, variant.scale, thresholds[ti], e])
            }
          }
        }
      }
      // 兜底：全屏只试原尺度 + 高阈值（覆盖叉不在右上角的情况，且避免低阈值误匹配）
      if (!done) {
        try {
          let p = images.findImage(grayScreen, tplVariants[0].img, { threshold: 0.85, region: [0, 0, sw, sh] })
          if (p) {
            point = {
              x: p.x,
              y: p.y,
              w: tplVariants[0].img.getWidth(),
              h: tplVariants[0].img.getHeight(),
              scale: 1,
              threshold: 0.85,
              regionIndex: 3,
              cost: new Date().getTime() - startTime
            }
          }
        } catch (e) {
          logUtils.debugInfo(['识图全屏兜底异常：{}', e])
        }
      }
    } catch (e) {
      this.pushWarningLog('识图找' + desc + '异常：' + e)
    } finally {
      tplVariants.forEach(function (item) {
        try {
          item.img.recycle()
        } catch (e) {
          // 忽略
        }
      })
      try {
        if (grayScreen) {
          grayScreen.recycle()
        }
      } catch (e) {
        // 忽略
      }
    }
    if (!point) {
      this.pushLog('识图未找到' + desc + '（模板' + tw + 'x' + th + ' 屏幕' + sw + 'x' + sh
        + ' 已试区域' + regions.length + '×尺度' + scales.length + '×阈值' + thresholds.length + '+全屏兜底）')
      return null
    }
    this.pushLog('识图找到' + desc + '：坐标' + point.x + ',' + point.y + ' 区域' + point.regionIndex
      + ' 尺度' + point.scale + ' 阈值' + point.threshold + ' 耗时' + point.cost + 'ms')
    let hitX = point.x
    let hitY = point.y
    let hitW = point.w
    let hitH = point.h
    return {
      bounds: () => ({
        centerX: () => hitX + hitW / 2,
        centerY: () => hitY + hitH / 2
      })
    }
  }

  /**
   * 广告中出现「领取福利/放弃福利」弹窗：选择「放弃福利」继续看满
   * （识别到「继续」说明本次广告可不跳转直接看满拿奖励，放弃额外福利避免中断/触发跳转）
   * 控件优先，OCR 兜底（WebView 广告控件不可见时）
   * @returns {boolean} 是否点了放弃福利
   */
  this.abandonWelfareIfPresent = function () {
    let btn = widgetUtils.widgetGetOne('^放弃福利$', 500, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击「放弃福利」（继续看满）')
      automator.clickCenter(btn)
      sleep(500)
      return true
    }
    btn = widgetUtils.widgetGetOne('放弃福利', 400, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击「放弃福利」（模糊命中）')
      automator.clickCenter(btn)
      sleep(500)
      return true
    }
    // OCR 兜底：控件不可见（WebView 广告）时识图识别「放弃福利」并点击
    if (localOcrUtil.enabled) {
      let find = this.ocrFind('放弃福利', '放弃福利', [0, Math.floor(config.device_height * 0.3), config.device_width, Math.floor(config.device_height * 0.5)], true)
      if (find) {
        this.pushLog('点击「放弃福利」（OCR识别）')
        sleep(500)
        return true
      }
    }
    return false
  }

  /**
   * 处理关闭广告后的挽留弹窗：「继续观看 / 残忍离开」-> 选「继续观看」
   * @returns {boolean} 是否点了继续观看
   */
  this.handleKeepWatchingDialog = function () {
    let btn = widgetUtils.widgetGetOne('^继续观看$', 800, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击挽留弹窗「继续观看」')
      automator.clickCenter(btn)
      sleep(1000)
      return true
    }
    btn = widgetUtils.widgetGetOne('继续观看', 600, false, true)
    if (btn && automator.checkCenterClickable(btn)) {
      this.pushLog('点击「继续观看」（模糊命中）')
      automator.clickCenter(btn)
      sleep(1000)
      return true
    }
    return false
  }

  /**
   * 跳转应用后上下滑动屏幕，触发广告倒计时继续（部分广告跳转后倒计时会暂停）
   */
  this.triggerCountdownBySwipe = function () {
    let w = config.device_width
    let h = config.device_height
    let cx = Math.floor(w / 2)
    try {
      this.pushLog('跳转后滑动屏幕触发倒计时继续')
      // 上滑：屏中下部 -> 上部
      automator.swipe(cx, Math.floor(h * 0.7), cx, Math.floor(h * 0.3), 400)
      sleep(500)
      // 下滑：屏中上部 -> 下部（来回一次更易触发倒计时）
      automator.swipe(cx, Math.floor(h * 0.3), cx, Math.floor(h * 0.7), 400)
      sleep(500)
    } catch (e) {
      this.pushWarningLog('滑屏触发倒计时异常：' + e)
    }
  }

  /**
   * 判断当前是否在应用商店（下载类广告特征，如 vivo应用商店 com.bbk.appstore）
   */
  this.isDownloadStore = function () {
    let pkg = ''
    try {
      pkg = commonFunctions.myCurrentPackage() || ''
    } catch (e) {
      return false
    }
    if (!pkg) {
      return false
    }
    return pkg == 'com.bbk.appstore' || /store|market|appstore|应用商店/.test(pkg)
  }

  /**
   * 下载类广告：取消下载并返回云宝宝，直接关闭广告（挽留弹窗点「关闭广告」）
   */
  this.cancelDownloadAndClose = function () {
    this.pushLog('取消下载并返回云宝宝')
    // 返回键退出应用商店/取消下载（最多3次，回到云宝宝即停）
    for (let i = 0; i < 3; i++) {
      if (commonFunctions.myCurrentPackage() == _package_name) {
        break
      }
      try {
        automator.back()
      } catch (e) {
        logUtils.debugInfo(['退出商店返回键异常：{}', e])
      }
      sleep(800)
    }
    this.backToYunbaobao()
    // 直接关闭广告：关闭后挽留弹窗点「关闭广告」，不点「继续观看」
    this.closeAdIfPossible(false, true)
  }

  /**
   * 关闭可能残留的弹窗
   */
  this.closePopup = function () {
    let closeBtn = widgetUtils.widgetGetOne('(关闭|知道了|好的|取消)', 1500, false, true)
    if (closeBtn && automator.checkCenterClickable(closeBtn)) {
      this.pushLog('关闭残留弹窗')
      automator.clickCenter(closeBtn)
      sleep(800)
      return true
    }
    return false
  }

  /**
   * 等待指定秒数（带倒计时日志与超时保护）
   */
  this.waitAndLog = function (seconds, prefix) {
    this.pushLog(prefix + ' 等待' + seconds + '秒')
    while (seconds-- > 0) {
      if (this.isTimeout()) {
        return
      }
      sleep(1000)
      this.replaceLastLog(prefix + ' 剩余' + seconds + '秒')
    }
  }
}

SignRunner.prototype = Object.create(BaseSignRunner.prototype)
SignRunner.prototype.constructor = SignRunner

module.exports = new SignRunner()
