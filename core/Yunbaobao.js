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
  { regex: /点击打开或下载第三方应用/, desc: '点击打开或下载第三方应用' },
  { regex: /打开或下载第三方应用/, desc: '打开或下载第三方应用' },
  { regex: /下载第三方应用/, desc: '下载第三方应用' },
  { regex: /(去体验|体验|试玩|去玩).{0,10}\d+\s*(秒|s)/, desc: '去体验N秒（必须跳转）' },
  // 「点击广告，即可获得奖励」类：点一下跳转就算完成，跳转后可以直接返回，不用等倒计时（noWait）
  { regex: /点击(该|此)?广告.{0,10}(即可|就能|便能|马上).{0,6}(获得|领取|得).{0,4}(奖励|云币)/, desc: '点击广告即可获得奖励（可直接返回）', noWait: true },
]

/**
 * 判断一段文案是否为「可看满」倒计时文案（不是跳转）
 * 可看满：奖励将于N秒后发放 / 观看视频N秒后可领取 / 15秒后发放、可领取（无动作词）
 * 必须跳转：去体验N秒后可直接拿奖励 / 体验N秒 / 跳转、下载、加速、打开、前往 + N秒
 * —— 判错会导致「本该跳转的却在那等」，所以带跳转动作词的永远按跳转处理
 */
function isRewardCountdownText (text) {
  if (!text) {
    return false
  }
  text = String(text).replace(/\s+/g, '')
  // ① 带跳转/体验类动作词 + 秒数 = 必须跳转，不是看满
  if (/(去体验|体验|试玩|去玩|跳转|加速|下载|安装|打开|前往)/.test(text) && /\d+\s*(秒|s)/.test(text)) {
    return false
  }
  // ② 明确的看满文案
  if (/奖励将于/.test(text)) {
    return true
  }
  if (/(观看|看)\s*(视频|广告).{0,10}\d+\s*(秒|s)/.test(text)) {
    return true
  }
  if (/奖励.{0,10}\d+\s*(秒|s)/.test(text)) {
    return true
  }
  // ③ 「N秒后发放 / 可领取 / 可拿」且没有动作词 = 看满倒计时
  if (/\d+\s*(秒|s).{0,10}(发放|领取|可领|可拿|拿奖励|领奖励)/.test(text)) {
    return true
  }
  return false
}

/**
 * 判断一段文案是否为跳转类广告文案
 * 先排除「可看满」倒计时文案，再匹配已知情况表，最后走兜底启发式：领取类文案 + 动作词
 */
function isJumpAdText (text) {
  if (!text) {
    return false
  }
  text = String(text).replace(/\s+/g, '')
  // 带「N秒后可拿/领取」的是看满倒计时，不是跳转（避免被下方「我要加速领奖励」带偏）
  if (isRewardCountdownText(text)) {
    logUtils.debugInfo(['命中可看满倒计时文案，不按跳转处理：{}', text])
    return false
  }
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
 * 取出命中的跳转文案情况表条目（用来读 noWait 这类标记）
 * 「点击广告即可获得奖励」这种点一下就算完成，跳转后可以直接返回
 * @param {String} text 文案
 * @returns {Object|null}
 */
function matchJumpAdCase (text) {
  if (!text) {
    return null
  }
  text = String(text).replace(/\s+/g, '')
  if (isRewardCountdownText(text)) {
    return null
  }
  for (let i = 0; i < JUMP_AD_CASES.length; i++) {
    if (JUMP_AD_CASES[i].regex.test(text)) {
      return JUMP_AD_CASES[i]
    }
  }
  return null
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
    // 每次执行重置广告轮次计数与广告类型标记
    this._adCount = 0
    this._reachLimit = false
    this._miniGameAd = false
    this._keepWatchAd = false
    this._restarting = false
    // 关闭叉识图失败时间戳：同一屏连续调用时避免重复做整轮匹配
    this._closeTplMissAt = 0
    // 是否追奖励弹窗下方的「观看视频后开启」（默认追，只有惊喜礼包/开宝箱这类连看入口需要）
    this._allowChainNextAd = true
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
    // 第一次进入赚云币页会弹「签到成功」，下方「额外领取云币」点一次可看广告，看完回点「我知道了」
    this.handleSignSuccessBonusDialog()
    // 依次执行各广告任务（测试界面可通过 onlySubTask 指定只跑某个子任务，日常执行时为空=全部执行）
    // 依次执行各广告任务（测试界面可通过 onlySubTask 指定只跑某个子任务，日常执行时为空=全部执行）
    // 每个子任务单独 try/catch：单个任务异常不再把整个脚本打死（异常终止后框架会当成脚本崩溃）
    let self = this
    let safeRun = function (name, fn) {
      try {
        fn()
      } catch (e) {
        self.pushWarningLog('子任务「' + name + '」执行异常，已跳过继续：' + e)
        logUtils.errorInfo(['子任务「{}」执行异常：{}', name, e])
      }
    }
    let only = this.onlySubTask
    if (!only || only == 'giftPackage') {
      safeRun('惊喜礼包', () => this.doGiftPackage())
    }
    if (!only || only == 'openBox') {
      safeRun('开宝箱赚云币', () => this.doOpenBox())
    }
    if (!only || only == 'dailyCheckIn') {
      safeRun('每日打卡', () => this.doDailyCheckIn())
    }
    if (!only || only == 'dailyWatchVideo') {
      safeRun('每日看视频', () => this.doDailyWatchVideo())
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
    let stopNames = ['强行停止', '结束运行', '强制停止', '停止运行']
    // 系统设置页按钮文字控件的资源id（有的版本要写完整包名id，两种都试）
    let buttonIds = ['vbutton_title', 'com.android.settings:id/vbutton_title']
    // 定位「强行停止」按钮：优先系统设置页的按钮文字控件（com.android.settings:id/vbutton_title）
    let findStopBtn = function () {
      for (let k = 0; k < buttonIds.length; k++) {
        for (let i = 0; i < stopNames.length; i++) {
          try {
            let el = selector().id(buttonIds[k]).textContains(stopNames[i]).findOne(200)
            if (el) {
              return { node: el, name: stopNames[i] }
            }
          } catch (e) {
            // 忽略
          }
        }
      }
      for (let i = 0; i < stopNames.length; i++) {
        try {
          let el = textContains(stopNames[i]).findOnce()
          if (el && el.text() && el.text().indexOf('停止') >= 0) {
            return { node: el, name: el.text() }
          }
        } catch (e) {
          // 忽略
        }
      }
      return null
    }
    // 坐标点击：设置页里 node.click() 常常点了没反应，用坐标点击更可靠
    let tapNode = function (node) {
      try {
        let b = node.bounds()
        if (b && b.width() > 0 && b.height() > 0) {
          automator.click(Math.floor(b.centerX()), Math.floor(b.centerY()))
          return true
        }
      } catch (e) {
        logUtils.debugInfo(['坐标点击失败：{}', e])
      }
      try {
        if (node.clickable()) {
          node.click()
          return true
        }
        let parent = node.parent()
        if (parent) {
          parent.click()
          return true
        }
      } catch (e) {
        logUtils.debugInfo(['控件点击失败：{}', e])
      }
      return false
    }
    let findConfirm = function () {
      // 注意不要用裸「停止」，否则会命中页面上的「强行停止」按钮本身
      let names = ['确定', '确定停止']
      for (let i = 0; i < names.length; i++) {
        try {
          let el = text(names[i]).findOnce()
          if (el) {
            return el
          }
        } catch (e) {
          // 忽略
        }
      }
      try {
        let el = selector().id('android:id/button1').findOne(300)
        if (el && el.text() && /确定|停止/.test(el.text())) {
          return el
        }
      } catch (e) {
        // 忽略
      }
      return null
    }
    try {
      this.pushLog('打开云宝宝应用信息页，准备强制停止')
      app.openAppSetting(_package_name)
      sleep(2000)
      let found = null
      let start = new Date().getTime()
      while (!found && new Date().getTime() - start < 6000) {
        found = findStopBtn()
        if (!found) {
          sleep(300)
        }
      }
      // 首屏没有就滚动一屏再找（有的机型按钮在页面下方）
      if (!found) {
        try {
          let sv = scrollable().findOnce()
          if (sv) {
            sv.scrollForward()
          }
        } catch (e) {
          // 忽略
        }
        sleep(800)
        start = new Date().getTime()
        while (!found && new Date().getTime() - start < 5000) {
          found = findStopBtn()
          if (!found) {
            sleep(300)
          }
        }
      }
      if (!found) {
        this.pushWarningLog('应用信息页未找到「结束运行/强行停止」按钮')
        this.logVisibleTexts('应用信息页')
        backSafely()
        return false
      }
      // 点击最多 3 次：每次点完检查是否弹出确认框 / 按钮是否已变灰（已停止）
      let stopped = false
      for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
        this.pushLog('点击「' + found.name + '」（第' + (attempt + 1) + '次）')
        tapNode(found.node)
        sleep(900)
        let confirm = findConfirm()
        if (confirm) {
          this.pushLog('确认弹窗点击「' + (confirm.text() || '确定') + '」')
          tapNode(confirm)
          sleep(900)
          // 个别机型确认后还有第二层确认
          let confirm2 = findConfirm()
          if (confirm2) {
            tapNode(confirm2)
            sleep(800)
          }
          stopped = true
          break
        }
        // 没有确认框：按钮消失或变灰都说明已停止
        let again = findStopBtn()
        if (!again) {
          stopped = true
          break
        }
        let enabled = true
        try {
          enabled = again.node.enabled()
        } catch (e) {
          enabled = true
        }
        if (!enabled) {
          this.pushLog('「' + again.name + '」已变为不可点击，判定已停止')
          stopped = true
          break
        }
        found = again
        sleep(600)
      }
      if (!stopped) {
        this.pushWarningLog('多次点击「' + found.name + '」仍未确认停止')
      }
      this.pushLog('已执行「' + found.name + '」关闭云宝宝')
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

  /**
   * 轮询等待当前应用变为指定包名（刚启动时包名读到的可能是桌面/空，需要轮询）
   * @param {String} pkg 包名
   * @param {Number} timeout 超时毫秒
   */
  this.waitCurrentPackage = function (pkg, timeout) {
    let deadline = new Date().getTime() + (timeout || 3000)
    while (new Date().getTime() < deadline) {
      try {
        if (commonFunctions.myCurrentPackage() == pkg) {
          return true
        }
      } catch (e) {
        // 忽略
      }
      sleep(300)
    }
    return false
  }

  /**
   * 启动 / 唤回云宝宝：四种手段逐级降级，每步都校验包名，全部 try/catch 包裹。
   * 之前只有 commonFunctions.launchPackage + app.launchApp，冷启动（刚强制停止后）经常失败，
   * 且 app.launchApp 按名称启动会阻塞/抛异常，把整个脚本一起打死。
   * @param {String} purpose 用途（日志用）
   * @returns {boolean} 是否确认已在前台
   */
  this.launchYunbaobaoPackage = function (purpose) {
    let ptag = purpose ? '（' + purpose + '）' : ''
    let names = ['框架launchPackage', 'app.launchPackage', '按应用名launchApp', 'MAIN/LAUNCHER intent']
    let tries = [
      function () {
        commonFunctions.launchPackage(_package_name)
      },
      function () {
        if (typeof app.launchPackage === 'function') {
          app.launchPackage(_package_name)
        }
      },
      function () {
        app.launchApp(_app_name)
      },
      function () {
        app.startActivity({
          action: 'android.intent.action.MAIN',
          category: 'android.intent.category.LAUNCHER',
          packageName: _package_name,
          flags: 0x10000000
        })
      }
    ]
    for (let i = 0; i < tries.length; i++) {
      if (this.isTimeout()) {
        return false
      }
      try {
        tries[i]()
        this.pushLog('启动云宝宝' + ptag + '：' + names[i])
      } catch (e) {
        this.pushWarningLog('启动云宝宝失败' + ptag + '（' + names[i] + '）：' + e)
        continue
      }
      if (this.waitCurrentPackage(_package_name, i === 0 ? 3000 : 2500)) {
        return true
      }
      this.pushWarningLog('启动后仍未进入云宝宝' + ptag + '（' + names[i] + '），尝试下一种方式')
    }
    return false
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
    let launched = this.launchYunbaobaoPackage('启动')
    if (!launched) {
      this.pushWarningLog('四种启动方式都未能把云宝宝拉到前台（当前包：' + commonFunctions.myCurrentPackage() + '）')
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
   * @param {Number} timeout 单次控件查询超时，默认 1200ms（高频轮询时传小值）
   */
  this.isOnCoinPage = function (timeout) {
    let limit = typeof timeout === 'number' ? timeout : 1200
    if (widgetUtils.widgetGetOne('(惊喜礼包|每日看视频10次)', limit, false, true)) {
      return true
    }
    // 惊喜礼包为图片控件时无文字，用原生资源id兜底
    try {
      if (selector().idMatches('iv_treasure_box').findOne(Math.min(limit, 600))) {
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
    // 不在赚云币页：先判断是不是广告残留盖住了（观看视频后开启 / 跳过 / 关闭叉），
    // 处理完再去找 Tab。这里不点「观看视频后开启」（会新开广告），只清残留。
    this.handleAdResidueAfterReturn('进入赚云币页前', false)
    if (this.isOnCoinPage()) {
      return true
    }
    // 仍能看到倒计时/跳过：广告还在，不能判定"页面异常"去强制重启（否则广告看一半就被杀掉重开）
    if (this.isAdPageVisible()) {
      this.pushLog('仍处于广告页（倒计时/跳过可见），不判定页面异常，交由广告流程收尾')
      return true
    }
    // 页面上只有「观看视频后开启」弹窗（赚云币页被弹窗盖住，文字锚点读不到）：
    // 不再去找 Tab，直接交给任务流程处理（GiftPackage/OpenBox 会自己点它）
    if (this.isOnGiftDialog()) {
      this.pushLog('检测到「观看视频后开启」弹窗，跳过 赚云币Tab 查找，交给任务流程')
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
        break
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
    // 兜底：页面卡死/异常（常见于停在广告页或黑屏、找不到赚云币Tab）→ 强制停止云宝宝后重新打开再试一次
    if (!this._restarting && !this.isTimeout()) {
      this._restarting = true
      this.pushWarningLog('页面异常，强制停止云宝宝后重新打开再试一次')
      let reopened = this.openYunbaobao()
      if (reopened) {
        // 重试期间保持 _restarting=true，防止重开后再失败导致无限重启
        let retry = this.enterCoinPage()
        this._restarting = false
        return retry
      }
      this._restarting = false
      this.pushWarningLog('强制停止后重新打开云宝宝失败')
    } else if (this._restarting) {
      this.pushWarningLog('已尝试重启云宝宝仍无法进入赚云币页，放弃本轮')
    }
    return false
  }

  /**
   * 返回赚云币页面（每日打卡/每日看视频看完广告后使用）
   */
  this.backToCoinPage = function (limit) {
    limit = limit || 5
    // 返回赚云币页前先清广告残留（观看视频后开启 / 跳过 / 关闭叉），
    // 否则残留广告盖着赚云币页，按返回键只会把云宝宝退到桌面
    if (this.handleAdResidueAfterReturn('回到赚云币页前', false) && this.isOnCoinPage()) {
      return true
    }
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
      // 小程序类广告跳转后的系统弹窗：有「禁止」先点禁止
      let deny = selector().text('禁止').findOne(quick ? 800 : 1500)
      if (deny && automator.checkCenterClickable(deny)) {
        this.pushLog('点击「禁止」（系统跳转弹窗）')
        automator.clickCenter(deny)
        sleep(800)
        return true
      }
      let btn = selector().text('仅打开一次').findOne(quick ? 800 : 1500)
      if (btn && automator.checkCenterClickable(btn)) {
        this.pushLog('点击 仅打开一次（跳转确认弹窗）')
        automator.clickCenter(btn)
        sleep(800)
        return true
      }
      if (!quick) {
        deny = widgetUtils.widgetGetOne('(^禁止$|不允许)', 1000, false, true)
        if (deny && automator.checkCenterClickable(deny)) {
          this.pushLog('点击「禁止」（系统跳转弹窗）')
          automator.clickCenter(deny)
          sleep(800)
          return true
        }
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
  /**
   * 按资源id在「下半屏」挑最靠右下的那个（悬浮按钮类入口，如开宝箱 cl_bg）
   * 同一个 id 常在列表/卡片容器上复用，直接 findOne 容易点到无关控件
   * @param {String} idShort 资源id（支持正则）
   */
  this.pickBottomRightEntry = function (idShort) {
    let list = null
    try {
      list = selector().idMatches(idShort).find()
    } catch (e) {
      logUtils.debugInfo(['idMatches 批量查找不可用：{}', e])
      return null
    }
    if (!list || list.length == 0) {
      return null
    }
    let best = null
    let bestScore = -1
    for (let i = 0; i < list.length; i++) {
      let b = null
      try {
        b = list[i].bounds()
      } catch (e) {
        continue
      }
      if (!b) {
        continue
      }
      let w = b.width()
      let h = b.height()
      if (w <= 0 || h <= 0) {
        continue
      }
      let cx = b.centerX()
      let cy = b.centerY()
      if (cy < config.device_height * 0.45) {
        continue
      }
      // 评分：越靠右下越优先；靠右加分；尺寸过大（整屏容器）降权；可点击加分
      let score = (cx / config.device_width) + (cy / config.device_height)
      if (cx > config.device_width * 0.5) {
        score += 1
      }
      if (w < config.device_width * 0.6 && h < config.device_height * 0.4) {
        score += 0.5
      }
      try {
        if (list[i].clickable()) {
          score += 0.5
        }
      } catch (e) {
        // 忽略
      }
      if (score > bestScore) {
        bestScore = score
        best = list[i]
      }
    }
    if (best) {
      try {
        let b = best.bounds()
        this.pushLog('按资源id找到下半屏入口：' + idShort + ' @' + b.centerX() + ',' + b.centerY()
          + ' (' + b.width() + 'x' + b.height() + ') 候选' + list.length + '个')
      } catch (e) {
        // 忽略
      }
    } else {
      logUtils.debugInfo(['资源id {} 有{}个候选但都不在下半屏：{}', idShort, list.length, ''])
    }
    return best
  }

  this.findEntry = function (idShort, fullId, text, desc, preferBottom) {
    // 1) 原生 idMatches（与 lib/Unlock.js 同款用法）
    try {
      let el
      if (preferBottom) {
        el = this.pickBottomRightEntry(idShort)
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
    // 4) 文本：完整文案优先，再退到去掉「赚云币」后缀的短文案（图标下文字常分行）
    let textPatterns = [text]
    let shortText = String(text).replace(/赚云币|赚金币/g, '').trim()
    if (shortText && shortText != text) {
      textPatterns.push(shortText)
    }
    for (let i = 0; i < textPatterns.length; i++) {
      let el = widgetUtils.widgetGetOne(textPatterns[i], 1500, true, true)
      if (el) {
        this.pushLog('按文本找到：' + desc + '（匹配词：' + textPatterns[i] + '）')
        return el
      }
      // 控件文字找不到时，尝试父容器（图标+文字组合的入口）
      try {
        let nodes = selector().textContains(textPatterns[i]).find()
        if (nodes && nodes.length > 0) {
          let parent = nodes[0].parent()
          if (parent && parent.bounds() && parent.bounds().width() > 0) {
            this.pushLog('按文本父容器找到：' + desc + '（匹配词：' + textPatterns[i] + '）')
            return parent
          }
        }
      } catch (e) {
        logUtils.debugInfo(['文本父容器查找失败：{}', e])
      }
    }
    // 5) OCR（图片/WebView 渲染的标签）
    if (localOcrUtil.enabled) {
      for (let i = 0; i < textPatterns.length; i++) {
        let find = this.ocrFind(textPatterns[i], desc, null, false)
        if (find) {
          this.pushLog('按OCR找到：' + desc + '（匹配词：' + textPatterns[i] + '）')
          return find
        }
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
    return this.runVideoOpenLoop('惊喜礼包', GIFT_PACKAGE,
      'iv_treasure_box', 'com.babystar.enhanced:id/iv_treasure_box', '惊喜礼包', '惊喜礼包', false)
  }

  /**
   * 任务：开宝箱赚云币（逻辑与惊喜礼包一致，按钮都是「观看视频后开启」）
   */
  this.doOpenBox = function () {
    return this.runVideoOpenLoop('开宝箱赚云币', OPEN_BOX,
      'cl_bg', 'com.babystar.enhanced:id/cl_bg', '开宝箱赚云币', '开宝箱赚云币', true)
  }

  /**
   * 惊喜礼包 / 开宝箱共用流程：
   * 点入口 -> 弹窗「观看视频后开启」-> 点它看广告 -> 广告结束后（自动关闭或找叉关闭）出现「恭喜获得」，
   * 下方若仍是「观看视频后开启」就继续点，直到提示「已达上限」（约15次）为止
   */
  this.runVideoOpenLoop = function (tag, subTask, idShort, fullId, text, desc, preferBottom) {
    if (!config.is_test && this.isSubTaskExecuted(subTask)) {
      this.pushLog(tag + '已完成，跳过')
      return true
    }
    if (this.isTimeout()) {
      return false
    }
    // 确保仍在赚云币页（上一任务的广告可能未完全关闭）
    if (!this.ensureCoinPage(tag)) {
      this.pushWarningLog('不在赚云币页且进入失败')
      return false
    }
    this.pushLog('查找 ' + tag)
    // 入口是图片控件：原生id/框架id/文本/OCR 多层识别，找不到时下滑重试
    let entry = this.findEntryWithScroll(idShort, fullId, text, desc, preferBottom)
    let popupAlreadyOpened = false
    if (!entry && preferBottom) {
      // 悬浮按钮（开宝箱）兜底：图标可能是纯图片且 id 在真机上不存在，按右下角悬浮位固定点一次
      let fx = Math.floor(config.device_width * 0.86)
      let fy = Math.floor(config.device_height * 0.80)
      this.pushLog(tag + ' 入口识别失败，按悬浮按钮位置兜底点击：' + fx + ',' + fy)
      automator.click(fx, fy)
      sleep(1500)
      let probe = widgetUtils.widgetGetOne('观看视频.{0,6}开启|看视频.{0,6}开启|观看广告.{0,6}开启', 2500)
      if (probe) {
        this.pushLog('悬浮位兜底点击成功，已弹出「观看视频后开启」')
        popupAlreadyOpened = true
        entry = { fallback: true }
      }
    }
    if (!entry) {
      this.pushWarningLog('未找到 ' + tag + '（当前包：' + commonFunctions.myCurrentPackage() + '，赚云币页：' + this.isOnCoinPage() + '）')
      this.logVisibleTexts(tag)
      return false
    }
    if (!popupAlreadyOpened && !this.clickByBounds(entry, tag)) {
      this.pushWarningLog('未找到 ' + tag)
      return false
    }
    if (!popupAlreadyOpened) {
      sleep(1200)
    }
    let openBtn = widgetUtils.widgetGetOne('观看视频.{0,6}开启|看视频.{0,6}开启|观看广告.{0,6}开启', 3000)
    if (!openBtn) {
      this.pushWarningLog('未出现「观看视频后开启」按钮')
      this.closePopup()
      this.setSubTaskExecuted(subTask)
      return true
    }
    // 每次任务开始重置「已达上限」标记
    this._reachLimit = false
    this.pushLog('点击「观看视频后开启」看广告（真机上限约15次，命中「已达上限」即停）')
    this.clickNextAdAndCheckLimit(openBtn, '观看视频后开启')
    if (this._reachLimit) {
      this.pushLog(tag + ' 已达观看上限，结束')
    } else {
      this.watchAd(tag)
    }
    // 收尾：广告若仍未关闭，按完整关闭流程关掉，避免残留广告页影响后续任务
    if (this.isAdPageVisible()) {
      this.pushLog('广告结束后仍有广告页迹象，执行关闭')
      this.closeAdIfPossible()
    }
    this.closePopup()
    this.setSubTaskExecuted(subTask)
    return true
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
    let notOpened = 0
    let finished = false
    // 判断是否已看完（方式1）：识别「每日看视频10次(N/10)」里的次数，已到 10 直接结束
    let done = this.readDailyWatchProgress()
    if (done >= 10) {
      this.pushLog('每日看视频任务次数已满（' + done + '/10），无需再看')
      finished = true
    }
    while (!finished && watched < maxWatch) {
      if (this.isTimeout()) {
        this.pushWarningLog('执行超时，结束每日看视频')
        break
      }
      let progressBtn = this.findProgressBtn()
      if (!progressBtn) {
        this.pushLog('未找到 每日看视频10次 的 进行中 按钮（可能已完成或入口消失）')
        finished = true
        break
      }
      this.pushLog('每日看视频 第' + (watched + 1) + '次（已看满 ' + watched + ' 条）')
      if (!this.clickBtn(progressBtn, '进行中-看视频')) {
        this.pushWarningLog('进行中 按钮点击失败，结束每日看视频')
        break
      }
      // 判断是否已看完（方式2）：点击后约1秒出现「任务已完成」，显示约2秒后消失
      if (this.checkTaskCompletedHint(2500)) {
        this.pushLog('每日看视频任务已完成（点击后出现「任务已完成」提示）')
        finished = true
        break
      }
      // 关键：先确认广告真的打开了。点了没反应时若直接进 watchAd，
      // 会在空页面上做完整轮识别（等广告页 + 识图 + 返回），一次白等一两分钟，
      // 看起来就是「卡在每日看视频第一次，一直不往下走」
      if (!this.waitAdOpened(6)) {
        notOpened++
        this.pushWarningLog('点击「进行中」后没有检测到广告页（第' + notOpened + '次）')
        if (this.isOnCoinPage() && notOpened >= 2) {
          this.pushWarningLog('连续' + notOpened + '次点击都没打开广告，可能今日次数已用完或入口失效，结束每日看视频')
          break
        }
        continue
      }
      notOpened = 0
      watched++
      // 每日看视频是「点一次 = 看一条」，不允许在奖励弹窗里接着看下一条，
      // 否则一条广告能连着看十几分钟，外层看不到进度
      this.watchAd('每日看视频', { allowChainNextAd: false, skipBetweenWait: true })
      // 看完后回到赚云币页，准备下一次（残留广告先关闭再回）
      if (!this.ensureCoinPage('每日看视频-回页')) {
        this.pushWarningLog('返回赚云币页失败，结束每日看视频')
        break
      }
      // 再看一眼进度文字，已到 10/10 就收工
      let nowDone = this.readDailyWatchProgress()
      if (nowDone >= 10) {
        this.pushLog('每日看视频次数已满（' + nowDone + '/10），结束')
        finished = true
        break
      }
    }
    if (finished || watched > 0) {
      this.setSubTaskExecuted(DAILY_WATCH_VIDEO)
      return true
    }
    this.pushWarningLog('每日看视频未执行到任何一次，不标记完成')
    return false
  }

  /**
   * 点击广告入口后确认广告是否真的打开
   * 「已打开」判定：已跳到其它应用 / 出现倒计时·跳过·关闭等广告元素 / 已离开赚云币页
   * 只用轻量控件判定（不做 OCR），最多等 waitSeconds 秒，避免看视频这类任务白等
   * @param {Number} waitSeconds 最长等待秒数
   * @returns {Boolean}
   */
  this.waitAdOpened = function (waitSeconds) {
    waitSeconds = waitSeconds || 6
    let start = new Date().getTime()
    while (new Date().getTime() - start < waitSeconds * 1000) {
      if (this.isTimeout()) {
        return false
      }
      if (commonFunctions.myCurrentPackage() != _package_name) {
        this.pushLog('已跳转其它应用，判定广告已打开')
        return true
      }
      if (this.isAdPageVisible()) {
        this.pushLog('检测到广告页元素，判定广告已打开')
        return true
      }
      if (!this.isOnCoinPage(500)) {
        this.pushLog('页面已离开赚云币页，判定广告已打开')
        return true
      }
      sleep(800)
    }
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
   * 广告结束返回后，若奖励/礼包弹窗下方还有「观看视频后开启」，会点击并继续观看下一条广告
   * （惊喜礼包、开宝箱这类入口单次可连续看，真机上限约 15 次；命中「已达上限」立即停止，防止死循环）
   * @param {String} desc 描述
   * @param {Object} options { allowChainNextAd: false } 不追弹窗里的下一条广告
   *   —— 每日看视频这种「点一次进行中 = 看一条广告」的任务必须传 false，
   *      否则会在这条广告里连着看十几分钟，外层进度看起来就卡死不动
   *   { skipBetweenWait: true } 跳过两次广告间 10~50 秒的随机等待
   *   —— 每日看视频要点 10 次，每次都空等半分钟会平白多出好几分钟
   */
  this.watchAd = function (desc, options) {
    options = options || {}
    this._allowChainNextAd = options.allowChainNextAd !== false
    // 每进入一条新的广告流程都重新判断「已达上限」，避免上一任务的标记影响后续任务
    this._reachLimit = false
    // 两次广告间随机间隔：放在「进入下一条广告之前」，先打印再等待
    if (this._adCount && this._adCount > 0 && options.skipBetweenWait !== true) {
      this.waitBetweenAds()
    }
    let maxRounds = 15
    let result = true
    for (let round = 0; round < maxRounds; round++) {
      if (this._reachLimit) {
        this.pushLog('已提示达到观看上限，结束本轮连续观看')
        break
      }
      this._needNextAd = false
      result = this.watchOneAdRound(round === 0 ? desc : desc + '(续' + round + ')')
      if (this._reachLimit || !this._needNextAd || this.isTimeout()) {
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
    // 每次观看广告重置「继续」点击去重记录与广告类型标记
    this._continueClicked = {}
    this._keepWatchAd = false
    this._miniGameAd = false
    this._reachLimit = false
    // 重置「继续看下一条」标记：否则上一轮的值会让返回后的 residue 判断误判
    this._needNextAd = false
    // 广告进入后先延时等待页面加载完成，避免把广告前页面误识别为广告元素
    sleep(3000)
    // 等待广告页加载完成（控件 + OCR 双通道）
    let adInfo = this.waitForAdPage(8)
    let result = false
    if (adInfo) {
      if (adInfo.wechat) {
        result = this.handleWechatAd()
        // 小程序返回后停在「恭喜获得」，下方若还有「观看视频后开启」就继续看
        this.continueIfNextAdButton()
      } else if (adInfo.jumpBtn && !adInfo.keepWatch) {
        result = this.watchJumpAd(adInfo.jumpBtn, desc)
      } else {
        if (adInfo.jumpBtn && adInfo.keepWatch) {
          // 右上角「奖励将于N秒后发放」+ 下方「我要加速领奖励」：以看满为准，不点跳转
          this.pushLog('该广告可看满（奖励将于N秒后发放），忽略跳转按钮：' + (adInfo.jumpBtn.content || ''))
        }
        this._keepWatchAd = !!adInfo.keepWatch
        result = this.watchCountdownAd(desc)
      }
    } else if (this.isWechatForeground()) {
      // 已跳进微信：小程序 / 小游戏类广告，走专门流程
      this.pushLog('广告落在微信内（小程序/小游戏类）')
      result = this.handleWechatAd()
      this.continueIfNextAdButton()
    } else if (commonFunctions.myCurrentPackage() != _package_name) {
      // 未能识别广告页：若已跳转其它应用，按跳转广告处理
      this.pushLog('广告已跳转其它应用，按跳转领取处理')
      // 跳转时可能出现系统确认弹窗「***想要打开***」，点击 禁止/仅打开一次
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
          if (adInfo2.wechat) {
            result = this.handleWechatAd()
            this.continueIfNextAdButton()
          } else if (adInfo2.jumpBtn && !adInfo2.keepWatch) {
            result = this.watchJumpAd(adInfo2.jumpBtn, desc)
          } else {
            this._keepWatchAd = !!adInfo2.keepWatch
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
    limit = limit || 8
    // 用「实际耗时」做预算：原先按循环次数算，每轮里的 OCR/控件查询很慢，
    // 8 轮叠加起来可能 1 分钟以上，任务看着就像卡死
    let deadline = new Date().getTime() + limit * 1000
    let ocrRound = 0
    let topRegion = m => m.boundsInside(config.device_width * 0.3, 0, config.device_width, config.device_height * 0.35)
    let topLimitY = config.device_height * 0.35
    let countdownLeftX = config.device_width * 0.3
    while (new Date().getTime() < deadline) {
      if (this.isTimeout()) {
        return null
      }
      // 0) 已跳进微信（小程序/小游戏类广告）：交给专门流程处理
      if (this.isWechatForeground()) {
        return { countdown: null, closeBtn: null, jumpBtn: null, wechat: true }
      }
      // 0.1) 「奖励将于N秒后发放」：明确可以看满，优先于跳转按钮（不能被「我要加速领奖励」带偏去跳转）
      if (this.rewardCountdownVisible()) {
        return { countdown: { content: '奖励将于N秒后发放' }, closeBtn: null, jumpBtn: null, keepWatch: true }
      }
      // 0) 优先点「继续看视频」留在应用内（控件快查，命中即点击并重新检测）
      if (this.clickContinueAdIfPresent(true)) {
        continue
      }
      // 1) 跳转类按钮（控件，已知文案快查）—— 优先于倒计时
      let jumpBtn = this.findJumpButtonByWidgetFast()
      if (jumpBtn) {
        // 兜底：再 OCR 确认页面上是否存在「N秒后可拿奖励」看满文案（这类文案常以图片形式出现）
        if (this.rewardCountdownByOcr()) {
          this.pushLog('页面上存在可看满倒计时文案，按看满处理，忽略跳转按钮')
          return { countdown: { content: '可看满倒计时' }, closeBtn: null, jumpBtn: jumpBtn, keepWatch: true }
        }
        return { countdown: null, closeBtn: null, jumpBtn: jumpBtn }
      }
      // 2) OCR 全屏识别：先扫「继续」文案，再找跳转文案，最后找右上角倒计时
      // 全屏 OCR 很慢，隔一轮做一次即可（控件快查每轮都做，命中更快）
      if (localOcrUtil.enabled && (ocrRound++ % 2) === 0) {
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
            // 2b) 「奖励将于N秒后发放」「去体验N秒后可直接拿奖励」优先（可看满），避免被下方「我要加速领奖励」误判成跳转
            for (let i = 0; i < finds.length; i++) {
              let label = finds[i].label || ''
              if (isRewardCountdownText(label)) {
                this.pushLog('OCR识别到可看满提示：' + label)
                return { countdown: { bounds: () => finds[i].bounds, content: label }, closeBtn: null, jumpBtn: null, keepWatch: true }
              }
            }
            // 2c) 跳转文案（含「去体验X秒后可拿奖励」类引导，命中即按跳转处理）
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
      let tick = 0
      while (new Date().getTime() - start < wait * 1000) {
        if (this.isTimeout()) {
          break
        }
        sleep(1000)
        tick++
        let remain = Math.max(0, Math.round((wait * 1000 - (new Date().getTime() - start)) / 1000))
        this.replaceLastLog('看广告中 剩余' + remain + '秒')
        // 重活（奖池弹窗判定里带全屏 OCR）每 3 秒做一次：
        // 以前每轮都做一次 OCR，1 秒的等待被拖成好几秒，一条 30 秒的广告能等 2 分钟
        if (tick % 3 === 0) {
          // 出现「领取福利/放弃福利」弹窗：选「放弃福利」（识别到继续说明可不跳转，继续看满拿奖励）
          if (this.abandonWelfareIfPresent()) {
            continue
          }
          // 回来再看一眼右上角：出现「奖励将于N秒后发放」说明这条能看满，后续忽略跳转
          if (!this._keepWatchAd && this.rewardCountdownVisible()) {
            this._keepWatchAd = true
            this._jumpFound = null
            this.pushLog('确认本广告可看满，忽略跳转按钮')
          }
        }
        // 监控线程发现跳转按钮 → 先 OCR 确认是不是「N秒后可拿奖励」的看满广告（别被下方「我要加速领奖励」带偏）
        if (this._jumpFound && !this._keepWatchAd) {
          if (this.rewardCountdownByOcr()) {
            this._keepWatchAd = true
            this._jumpFound = null
            this.pushLog('OCR确认页面可看满，忽略跳转按钮，继续等满')
            continue
          }
          let jumpBtn = this._jumpFound
          this._jumpFound = null
          this.pushLog('并行监控发现跳转按钮，切换为跳转领取')
          return this.watchJumpAd(jumpBtn, desc)
        }
        this._jumpFound = null
        // 监控发现「继续看视频」→ 点继续留在应用内（能不跳转就不跳转）
        if (this._continuePending) {
          this._continuePending = false
          this.clickContinueAdIfPresent(true)
          continue
        }
        // 提前检测到奖励/可领取状态则结束（每 2 秒查一次）
        if (tick % 2 === 0 && widgetUtils.widgetGetOne('(领取奖励|收下|确定|恭喜|奖励已发放|奖励已到账|获得.{0,8}(云币|奖励))', 600, false, true)) {
          this.pushLog('检测到奖励状态，提前结束')
          break
        }
      }
    } finally {
      this.stopJumpMonitor(monitor)
    }
    // 看满后监控可能刚发现跳转 → 优先处理跳转（跳转式弹窗常在倒计时结束时出现；可看满广告忽略）
    if (this._jumpFound && !this._keepWatchAd) {
      let jumpBtn = this._jumpFound
      this._jumpFound = null
      this.pushLog('看满后监控发现跳转按钮，切换为跳转领取')
      return this.watchJumpAd(jumpBtn, desc)
    }
    this._jumpFound = null
    this.claimRewardIfPossible()
    // 看满后右上角出现叉 / 关闭按钮，点击关闭
    this.closeAdIfPossible()
    // 关闭后若奖励弹窗/礼包弹窗下方还有「观看视频后开启」，说明还能继续看，交给外层继续
    // （仅在广告已关闭/无广告迹象时查找，避免把广告内的「观看视频X秒后领取」文案当成按钮）
    if (!this._reachLimit && !this.isAdPageVisible()) {
      let nextAd = this.findNextAdButton()
      if (nextAd) {
        this.waitBetweenAds()
        this.pushLog('奖励弹窗下方还有「观看视频」，继续观看下一条广告')
        if (this.clickNextAdAndCheckLimit(nextAd, '观看视频后开启(续)')) {
          this._needNextAd = !this._reachLimit
          return true
        }
      }
    }
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
    // 「点击广告，即可获得奖励」这类：点一下跳转就算完成，跳转后可以直接返回，不用等倒计时
    let jumpCase = matchJumpAdCase(content)
    let noWait = !!(jumpCase && jumpCase.noWait)
    let inStore = false
    if (noWait) {
      this.pushLog('该广告为「点击即可领取」类，跳转后直接返回，不等待倒计时')
      sleep(2500)
      this.confirmJumpDialogIfNeeded()
      // 先确认真的跳出去了：没跳说明这次点击没触发跳转，改回正常等待，别白白放弃这条广告
      if (commonFunctions.myCurrentPackage() == _package_name) {
        this.pushWarningLog('「点击即可领取」类广告没有发生跳转，改回正常等待流程')
        noWait = false
      }
    }
    if (!noWait) {
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
        // 每2秒复查一次「禁止/仅打开一次」弹窗 + 识别微信类广告 + 标记应用商店
        if (++loopCount % 2 == 0) {
          this.confirmJumpDialogIfNeeded(true)
          if (this.isWechatForeground()) {
            this.pushLog('等待期间识别到微信（小程序/小游戏类广告）')
            this.handleWechatAd()
            this.continueIfNextAdButton()
            return true
          }
          if (this.isDownloadStore()) {
            // 第6条：下载类广告不直接退出应用商店，留在商店界面上下滑动等待
            inStore = true
            if (!this._storeLogged) {
              this.pushLog('检测到应用商店，判定为下载类广告，在商店界面上下滑动等待')
              this._storeLogged = true
            }
          }
        }
        // 整个等待期间持续上下滑屏触发倒计时继续（应用商店内同样上下滑动）
        if (loopCount % 5 == 0) {
          this.triggerCountdownBySwipe()
        }
        this.replaceLastLog('跳转领取中 剩余' + wait + '秒')
      }
    }
    // 等待结束仍在应用商店（下载类广告）：返回云宝宝并关闭广告（挽留弹窗点「关闭广告」）
    if (!noWait && (inStore || this.isDownloadStore())) {
      this.pushLog('等待结束仍停留在应用商店，返回云宝宝并关闭下载类广告')
      this._storeLogged = false
      this.cancelDownloadAndClose()
      return true
    }
    this._storeLogged = false
    this.confirmJumpDialogIfNeeded()
    // 返回云宝宝，并确认当前应用：若识别到不是云宝宝则直接按包名/应用名打开
    let backOk = this.backToYunbaobao()
    if (!backOk) {
      this.pushWarningLog('未能返回云宝宝，再走一次拉回前台兜底')
      backOk = this.forceFrontYunbaobao()
    }
    if (!backOk) {
      this.pushWarningLog('未能返回云宝宝，跳过领取/关闭避免在其它应用误操作')
      return false
    }
    // backToYunbaobao 已经做过广告残留清理：若顺手点了「观看视频后开启」，直接算接上
    if (this._needNextAd) {
      this.pushLog('返回后已接上「观看视频后开启」，继续下一条广告')
      return true
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
      if (this.clickNextAdAndCheckLimit(nextAdBtn, '观看视频(奖励弹窗)')) {
        if (this._reachLimit) {
          // 已达上限：返回键关掉弹窗后，本轮不再继续
          this._needNextAd = false
          return true
        }
        this._needNextAd = true
        return true
      }
      this.pushWarningLog('「观看视频」按钮点击失败，按关闭流程处理')
    }
    // 没有「观看视频」按钮：广告未自动关闭就先关掉（找右上角叉/关闭），关闭后「恭喜获得」弹窗可能带「观看视频后开启」
    if (this.isOnGiftDialog()) {
      this.pushLog('返回后停留在惊喜礼包弹窗（未发现观看视频按钮），关闭弹窗')
      this.closePopup()
    } else {
      this.pushLog('广告未自动关闭，先按关闭流程关闭')
      this.closeAdIfPossible()
      sleep(1000)
      // 关闭后弹窗可能变成「恭喜获得」，下方仍有「观看视频后开启」→ 继续看
      if (this._needNextAd || this.continueIfNextAdButton()) {
        return true
      }
    }
    return true
  }

  /**
   * 找广告结束后奖励弹窗 / 惊喜礼包弹窗下方的「观看视频」按钮
   * （点它继续看下一条广告；区别于广告内的「继续看视频」挽留按钮）
   */
  this.findNextAdButton = function () {
    // 当前任务只点一次（如每日看视频）：奖励弹窗里的「观看视频后开启」不追，交给外层下一次点击
    if (this._allowChainNextAd === false) {
      return null
    }
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
   * 从广告 / 其它应用返回云宝宝后的第一步清理（用户要求：返回后不管什么情况，先别找赚云币 Tab）：
   * 按顺序检查 ①「观看视频后开启」②「跳过」③「关闭 / 关闭广告 / 知道了」④ 关闭叉模板识图，
   * 处理掉广告残留后才允许去找赚云币 Tab。
   * —— 之前是直接 enterCoinPage 找 Tab，残留广告盖在上面永远找不到 Tab，
   *    于是误判「页面异常」→ 强制停止重开 → 越走越糟。
   * @param {String} tag 日志标记
   * @returns {boolean} 是否已清理干净（或已接上继续看广告，此时 _needNextAd=true）
   */
  this.handleAdResidueAfterReturn = function (tag, allowNextAd) {
    if (commonFunctions.myCurrentPackage() != _package_name) {
      return false
    }
    let canChainNext = allowNextAd !== false && this._allowChainNextAd !== false
    let atag = tag || '返回后'
    for (let round = 0; round < 3; round++) {
      if (this.isTimeout()) {
        return false
      }
      let adish = this.isAdPageVisible()
      let gift = this.isOnGiftDialog()
      // 既没有广告迹象也不在礼包弹窗：不做识图（识图一轮 6 秒），直接交回调用方
      if (!adish && !gift) {
        if (this.isOnCoinPage()) {
          this.pushLog(atag + '未发现广告残留，页面已干净')
          return true
        }
        this.pushLog(atag + '无广告迹象（当前不在赚云币页），交回调用方导航')
        return false
      }
      // ① 奖励弹窗下方「观看视频后开启」：点它继续看下一条广告（不关闭弹窗）
      if (gift && canChainNext) {
        let nextAd = this.findNextAdButton()
        if (nextAd) {
          this.pushLog(atag + '检测到「观看视频后开启」，点击继续（不关闭弹窗）')
          this.waitBetweenAds()
          if (this.clickNextAdAndCheckLimit(nextAd, atag + '观看视频后开启')) {
            this._needNextAd = !this._reachLimit
            if (this._reachLimit) {
              this.pushLog(atag + '「观看视频后开启」已达上限，本轮不再继续')
            }
            return true
          }
          this.pushWarningLog('「观看视频后开启」点击失败，继续清理残留')
        }
      }
      // ② 跳过 / 跳过广告（文字）
      let skip = widgetUtils.widgetGetOne('^跳过$|跳过广告|跳过此广告', 800, false, true)
      if (skip && automator.checkCenterClickable(skip)) {
        this.pushLog(atag + '检测到「跳过」，点击')
        automator.clickCenter(skip)
        sleep(1000)
        continue
      }
      // ③ 关闭广告（下载类挽留弹窗）/ 关闭 / 知道了
      if (this.handleCloseAdDialog()) {
        this.pushLog(atag + '已点击挽留弹窗「关闭广告」')
        sleep(1000)
        continue
      }
      if (this.closePopup()) {
        this.pushLog(atag + '已关闭残留弹窗')
        sleep(1000)
        continue
      }
      // ④ 关闭叉模板识图：只做一轮，避免 3 轮 × 6 秒预算把流程拖死
      if (round == 0) {
        let closeIcon = this.findCloseByTemplate()
        if (closeIcon) {
          this.pushLog(atag + '识图找到关闭叉，点击')
          this.clickByBounds(closeIcon, atag + '关闭叉')
          sleep(1200)
          continue
        }
      }
      // ⑤ 仍有倒计时/跳过迹象：广告还没结束，等它自然结束再判断
      if (adish) {
        this.pushLog(atag + '仍识别到广告页迹象，等待其自然结束（第' + (round + 1) + '次）')
        sleep(2500)
        continue
      }
      return this.isOnCoinPage()
    }
    return this.isOnCoinPage() && !this.isAdPageVisible()
  }

  /**
   * 跳转到其它App后，回到云宝宝
   * 返回后校验当前应用：识别到不是云宝宝则直接按包名打开，包名未生效再按应用名打开
   */
  this.backToYunbaobao = function () {
    let limit = 3
    while (limit-- > 0) {
      if (commonFunctions.myCurrentPackage() == _package_name) {
        sleep(1000)
        // 关键：回到云宝宝后不要立刻去找赚云币 Tab，先处理广告残留
        this.handleAdResidueAfterReturn('返回云宝宝后')
        return true
      }
      this.pushLog('尝试返回云宝宝')
      if (this.launchYunbaobaoPackage('返回')) {
        sleep(800)
        this.handleAdResidueAfterReturn('返回云宝宝后')
        return true
      }
      // 还没回去：按返回键退出当前应用（多数跳转广告用返回键就能回云宝宝）
      this.pushLog('启动云宝宝未生效，按返回键退出当前应用')
      try {
        automator.back()
      } catch (e) {
        // 忽略
      }
      sleep(1200)
    }
    let final = commonFunctions.myCurrentPackage() == _package_name
    if (!final) {
      this.pushWarningLog('返回云宝宝失败（当前应用：' + commonFunctions.myCurrentPackage() + '）')
    } else {
      this.handleAdResidueAfterReturn('返回云宝宝后')
    }
    return final
  }

  /**
   * 广告关不掉时的硬兜底（返回键无效 / 被退到桌面）：
   * ① 把云宝宝拉回前台（广告页留在后台，界面回到赚云币页），还停在广告就再按一次返回
   * ② 仍不行就交给 enterCoinPage 的重启兜底（强制停止云宝宝后重开）
   * @returns {boolean} 是否回到了赚云币页
   */
  this.forceFrontYunbaobao = function () {
    for (let i = 0; i < 2; i++) {
      this.pushLog('硬兜底：把云宝宝拉回前台（第' + (i + 1) + '次）')
      this.launchYunbaobaoPackage('拉回前台')
      this.confirmJumpDialogIfNeeded(true)
      this.handleAdResidueAfterReturn('拉回前台后', false)
      if (commonFunctions.myCurrentPackage() == _package_name && this.isOnCoinPage(800) && !this.isAdPageVisible()) {
        this.pushLog('已把云宝宝拉回前台并回到赚云币页')
        return true
      }
      // 广告可能还盖在上面：再按一次返回
      automator.back()
      sleep(1200)
      if (this.isOnCoinPage(800)) {
        this.pushLog('再按返回后已回到赚云币页')
        return true
      }
    }
    this.pushWarningLog('拉回前台未成功，进入赚云币页的重启兜底')
    let ok = this.enterCoinPage()
    if (ok) {
      this.pushLog('重启云宝宝后已回到赚云币页')
    } else {
      this.pushWarningLog('重启云宝宝后仍未回到赚云币页')
    }
    return ok
  }

  /**
   * 兜底找关闭叉：广告的叉常常是个没有文字/desc 的 ImageView，
   * 这里在右上角范围内挑那个「独立的小可点击控件」点它（大尺寸广告层/整屏容器不选）
   * @returns {Object|null}
   */
  this.findTopRightCloseIcon = function () {
    let w = config.device_width
    let h = config.device_height
    let list = null
    try {
      list = selector().clickable().find()
    } catch (e) {
      logUtils.debugInfo(['右上角小图标查找不可用：{}', e])
      return null
    }
    if (!list || list.length === 0) {
      return null
    }
    let best = null
    let bestArea = 0
    for (let i = 0; i < list.length; i++) {
      let b = null
      try {
        b = list[i].bounds()
      } catch (e) {
        continue
      }
      if (!b) {
        continue
      }
      let bw = b.width()
      let bh = b.height()
      if (bw <= 8 || bh <= 8) {
        continue
      }
      // 叉在右上角：右侧 30%、顶部 20% 范围内
      if (b.centerX() < w * 0.7 || b.centerY() > h * 0.2) {
        continue
      }
      // 叉是小图标：排除整屏广告层、大按钮、进度条
      if (bw > w * 0.18 || bh > h * 0.1) {
        continue
      }
      if (bw * bh <= bestArea) {
        continue
      }
      best = list[i]
      bestArea = bw * bh
    }
    if (best) {
      this.pushLog('右上角候选关闭图标：坐标' + best.bounds().centerX() + ',' + best.bounds().centerY()
        + ' 尺寸' + best.bounds().width() + 'x' + best.bounds().height())
    }
    return best
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
   * 关闭广告：依次尝试 右上角控件跳过/关闭 -> 全屏关闭/知道了 -> OCR右上角 -> 识图找叉
   * -> 点右上角可点击小图标（叉常是无文字的 ImageView）-> 返回键 -> 硬兜底把云宝宝拉回前台
   * 关闭后可能出现挽留弹窗：普通广告选「继续观看」（afterAdClosed 处理，仅一次），
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
    // 3.6) 兜底：点右上角那个没有文字/desc 的小图标（很多广告的叉只是一个 ImageView）
    let iconClose = this.findTopRightCloseIcon()
    if (iconClose) {
      this.pushLog('未匹配到叉模板，改点右上角可点击小图标')
      this.clickByBounds(iconClose, '右上角小图标')
      sleep(1000)
      // 点完确认广告是否真的关掉了，没关掉就走后面的硬兜底
      if (!this.isAdPageVisible()) {
        this.afterAdClosed(keepWatchHandled, closeMode)
        return true
      }
      this.pushWarningLog('点击右上角小图标后仍是广告页，继续尝试返回键')
    }
    // 4) 返回键（已回到赚云币页时不再按返回，避免误退出应用）
    if (!this.isOnCoinPage()) {
      this.pushLog('未找到关闭按钮，使用返回键')
      automator.back()
      sleep(1200)
      // 返回键无效（还停在广告页 / 已经被退到桌面）：硬兜底把云宝宝拉回前台
      if (commonFunctions.myCurrentPackage() != _package_name || this.isAdPageVisible()) {
        this.pushWarningLog('返回键没有回到赚云币页，执行硬兜底')
        this.forceFrontYunbaobao()
      }
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

  // 内置关闭叉模板（assets/ad_close.png 的 base64）
  // 真机上工程的 assets/、config_data/ 没同步时用它兜底识图，避免「找不到文件」直接放弃
  const AD_CLOSE_TEMPLATE_B64 =
  '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' +
  'ps1PF56W9j+TQ97lYioV3AAAAABJRU5ErkJggg=='

  /**
   * 解析工程内相对文件路径（依次在 cwd 与其上两级目录中查找，避免真机 cwd 差异导致找不到模板）
   * @param {String} rel 相对路径，如 assets/ad_close.png
   * @returns {String|null} 存在的绝对路径
   */
  this.projectPath = function (rel) {
    let candidates = []
    let cwd = ''
    try {
      cwd = files.cwd()
    } catch (e) {
      cwd = ''
    }
    let p = cwd
    for (let i = 0; i < 3 && p; i++) {
      try {
        candidates.push(files.join(p, rel))
      } catch (e) {
        // 忽略
      }
      let idx = p.lastIndexOf('/')
      if (idx <= 0) {
        break
      }
      p = p.substring(0, idx)
    }
    // 有些启动方式（框架/SingleTaskExecutor）cwd 不是工程根目录，改用当前脚本所在目录再试一次
    try {
      let src = engines.myEngine().source
      if (src) {
        let dir = String(src)
        if (dir.indexOf('//') === 0) {
          dir = dir.substring(1)
        }
        let idx = dir.lastIndexOf('/')
        if (idx > 0) {
          candidates.push(files.join(dir.substring(0, idx), rel))
        }
      }
    } catch (e) {
      // 忽略
    }
    this._projectPathCandidates = candidates
    for (let i = 0; i < candidates.length; i++) {
      try {
        if (files.exists(candidates[i])) {
          return candidates[i]
        }
      } catch (e) {
        // 忽略
      }
    }
    return null
  }

  /**
   * 识图找右上角关闭叉：部分广告无关闭控件且返回键无效，必须手动点叉。
   * 模板来源（按优先级）：config 注入的 ad_close → config_data/yunbaobao/ad_close.data
   * → assets/ad_close.png → 脚本内置 base64（AD_CLOSE_TEMPLATE_B64，真机没同步工程文件时兜底）
   * @returns {Object|null} 可点击对象（bounds 提供 centerX/centerY），未找到返回 null
   */
  this.findCloseByTemplate = function () {
    // 同一屏连续调用会重复做整轮匹配（一次最多几秒），失败后 1.8 秒内不再重试
    let now = new Date().getTime()
    if (this._closeTplMissAt && now - this._closeTplMissAt < 1800) {
      return null
    }
    let b64 = ''
    // 1) config 注入的 base64（signConfig.js 里 bindCustomSignConfig('yunbaobao', {}, ['ad_close'])）
    let closeConfig = (config.yunbaobao_config && config.yunbaobao_config.ad_close) || ''
    // 注入值可能带换行/空白，先清洗，否则 fromBase64 会失败
    closeConfig = String(closeConfig).replace(/\s+/g, '').replace(/^data:image\/\w+;base64,/i, '')
    // 2) 直接读 data 文件：真机上 config_data 未同步/注入失败时仍可用
    if (!closeConfig || closeConfig.length <= 100) {
      let dataPath = this.projectPath('config_data/yunbaobao/ad_close.data')
      if (dataPath) {
        try {
          closeConfig = String(files.read(dataPath)).replace(/^\s+|\s+$/g, '')
          if (/^data:image/i.test(closeConfig)) {
            closeConfig = closeConfig.replace(/^data:image\/\w+;base64,/, '')
          }
          this.pushLog('关闭叉模板来源：' + dataPath + '，长度' + closeConfig.length)
        } catch (e) {
          this.pushWarningLog('读取关闭叉模板失败：' + e)
        }
      } else {
        this.pushLog('未找到 config_data/yunbaobao/ad_close.data，尝试 assets/ad_close.png')
      }
    }
    if (closeConfig && closeConfig.length > 100) {
      b64 = closeConfig
    }
    // 3) 兜底：assets/ad_close.png 模板文件
    if (!b64) {
      let tplPath = this.projectPath('assets/ad_close.png')
      let tpl = null
      if (tplPath) {
        try {
          this.pushLog('关闭叉模板来源：' + tplPath)
          tpl = images.read(tplPath)
        } catch (e) {
          this.pushWarningLog('读取关闭叉模板图失败（改走脚本内置模板）：' + e)
          tpl = null
        }
      }
      if (tpl) {
        try {
          b64 = images.toBase64(tpl)
        } catch (e) {
          logUtils.debugInfo(['模板图转base64失败：{}', e])
          b64 = ''
        }
        tpl.recycle()
      }
    }
    // 4) 最终兜底：脚本内置 base64 模板
    // 真机上 assets/ 和 config_data/ 常常没同步（原来会直接报「找不到文件」），内置一份就不会因此放弃识图
    if (!b64 && AD_CLOSE_TEMPLATE_B64 && AD_CLOSE_TEMPLATE_B64.length > 100) {
      b64 = AD_CLOSE_TEMPLATE_B64
      this.pushLog('关闭叉模板来源：脚本内置 base64（工程内模板文件不可用时兜底）')
      logUtils.debugInfo(['关闭叉模板内置兜底，cwd={}', files.cwd()])
    }
    if (!b64) {
      this.pushWarningLog('关闭叉模板不可用：config_data/yunbaobao/ad_close.data、assets/ad_close.png、内置模板都取不到（cwd=' + files.cwd() + '）')
      this._closeTplMissAt = new Date().getTime()
      return null
    }
    let res = this.findImgInTopRight(b64, '关闭叉')
    this._closeTplMissAt = res ? 0 : new Date().getTime()
    return res
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
   * 灰度多尺度模板匹配（修复「明明有叉却找不到」的几类原因）：
   * ① 原图灰度 + 彩色模板混合比较 → 相似度虚低：这里两边统一转灰度
   * ② 模板与真机截屏分辨率不同（叉的大小不一致）→ 逐一试 1.0 / 0.85 / 1.15 / 0.7 / 1.3 多种尺度
   * ③ 模板带深色底，压在亮色/花画面上时背景差异拉低相似度 → 再用「中心裁切模板」（只留叉笔画）匹配一遍
   * ④ 叉不在右上角 0.3 高范围内 → 区域分级：右上角窄带 → 左上角窄带 → 右上角 0.4w×0.35h → 上半屏右侧 → 全屏
   * 低阈值命中后再做形状校验，避免把深色视频里的暗块当成叉
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
    let thresholds = [0.82, 0.72, 0.62]
    let scales = [1, 0.85, 1.15, 0.7, 1.3]
    let regions = [
      [Math.floor(sw * 0.62), 0, Math.floor(sw * 0.38), Math.floor(sh * 0.12)],
      [0, 0, Math.floor(sw * 0.38), Math.floor(sh * 0.12)],
      [Math.floor(sw * 0.6), 0, Math.floor(sw * 0.4), Math.floor(sh * 0.35)],
      [Math.floor(sw * 0.5), 0, Math.floor(sw * 0.5), Math.floor(sh * 0.5)]
    ]
    let grayScreen = null
    let tplVariants = []
    let baseImgs = []
    let point = null
    try {
      grayScreen = images.cvtColor(images.grayscale(screen), 'GRAY2BGRA')
      // 两套模板：完整模板 + 中心裁切模板（去掉四周深色背景，叉压在亮/花画面时也能匹配上）
      baseImgs = [images.grayscale(tpl)]
      let cropped = null
      try {
        let cw = Math.max(8, Math.round(tw * 0.62))
        let ch = Math.max(8, Math.round(th * 0.62))
        cropped = images.clip(baseImgs[0], Math.round((tw - cw) / 2), Math.round((th - ch) / 2), cw, ch)
      } catch (e) {
        logUtils.debugInfo(['裁切关闭叉模板异常：{}', e])
        cropped = null
      }
      if (cropped) {
        baseImgs.push(cropped)
      }
      baseImgs.forEach(function (base, bi) {
        scales.forEach(function (s) {
          let tmp = null
          try {
            let g = base
            if (s !== 1) {
              tmp = images.resize(base, Math.round(base.getWidth() * s), Math.round(base.getHeight() * s))
              g = tmp
            }
            tplVariants.push({ scale: s, kind: bi, img: images.cvtColor(g, 'GRAY2BGRA') })
          } catch (e) {
            logUtils.debugInfo(['生成关闭叉模板变体异常：{}', e])
          } finally {
            if (tmp) {
              try {
                tmp.recycle()
              } catch (e) {
                // 忽略
              }
            }
          }
        })
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
                // 低阈值命中容易把深色视频里的暗块当成叉：命中后先验一次形状
                if (thresholds[ti] < 0.8) {
                  let shapeOk = this.verifyCrossShape(grayScreen, p.x, p.y, vw, vh)
                  if (shapeOk === false) {
                    continue
                  }
                }
                point = {
                  x: p.x,
                  y: p.y,
                  w: vw,
                  h: vh,
                  scale: variant.scale,
                  kind: variant.kind,
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
              kind: 0,
              threshold: 0.85,
              regionIndex: 4,
              cost: new Date().getTime() - startTime
            }
          }
        } catch (e) {
          logUtils.debugInfo(['识图全屏兜底异常：{}', e])
        }
      }
      // 未命中时做一次低阈值诊断，打印最高相似度：用于区分「阈值太高」还是「模板与真机叉样式差异过大」
      if (!point) {
        try {
          let best = images.matchTemplate(grayScreen, tplVariants[0].img, {
            threshold: 0.4,
            max: 1,
            region: regions[0]
          })
          let sim = null
          if (best && best.matches && best.matches.length > 0 && best.matches[0].similarity !== undefined) {
            sim = best.matches[0].similarity
          } else if (best && best.points && best.points.length > 0) {
            sim = '未知'
          }
          if (sim === null) {
            this.pushWarningLog('识图诊断：右上角区域内相似度均低于0.4（模板样式与页面不符，建议重截模板）')
          } else {
            this.pushWarningLog('识图诊断：右上角区域最高相似度' + sim + '（阈值下限0.62；低于0.62说明模板需重截）')
          }
        } catch (e) {
          logUtils.debugInfo(['识图诊断异常：{}', e])
        }
      }
    } catch (e) {
    } finally {
      tplVariants.forEach(function (item) {
        try {
          item.img.recycle()
        } catch (e) {
          // 忽略
        }
      })
      try {
        if (baseImgs) {
          baseImgs.forEach(function (img) {
            try {
              img.recycle()
            } catch (e) {
              // 忽略
            }
          })
        }
      } catch (e) {
        // 忽略
      }
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
      + ' 模板' + (point.kind === 1 ? '裁切' : '完整') + ' 尺度' + point.scale + ' 阈值' + point.threshold + ' 耗时' + point.cost + 'ms')
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
   * 形状校验：确认匹配到的小方块里真的是个「叉」（两条对角亮、四边中点暗）
   * 低阈值匹配在深色视频画面上容易误命中，命中后再验一次形状
   * @param {Object} grayImg 整屏灰度图（GRAY2BGRA）
   * @returns {Boolean|null} true/false 明确结果，null 表示无法判定（按命中处理）
   */
  this.verifyCrossShape = function (grayImg, x, y, w, h) {
    try {
      let ix = function (rx) { return Math.round(x + w * rx) }
      let iy = function (ry) { return Math.round(y + h * ry) }
      let maxX = grayImg.getWidth() - 1
      let maxY = grayImg.getHeight() - 1
      let sample = function (px, py) {
        let c = images.pixel(grayImg, Math.max(0, Math.min(maxX, px)), Math.max(0, Math.min(maxY, py)))
        return colors.red(c)
      }
      let diag = [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]]
      let edge = [[0.5, 0.1], [0.5, 0.9], [0.1, 0.5], [0.9, 0.5]]
      let center = sample(ix(0.5), iy(0.5))
      let diagVals = diag.map(p => sample(ix(p[0]), iy(p[1])))
      let edgeVals = edge.map(p => sample(ix(p[0]), iy(p[1])))
      let all = [center].concat(diagVals).concat(edgeVals)
      let min = Math.min.apply(null, all)
      let max = Math.max.apply(null, all)
      if (max - min < 25) {
        // 整块几乎同色，判断不了，交给相似度
        return null
      }
      let mid = min + (max - min) * 0.5
      let brightDiag = diagVals.filter(v => v > mid).length
      let darkEdge = edgeVals.filter(v => v < mid).length
      let pass = brightDiag >= 3 && darkEdge >= 3 && center > mid
      logUtils.debugInfo(['关闭叉形状校验：对角亮{}/4 边中暗{}/4 判定{}', brightDiag, darkEdge, pass])
      return pass
    } catch (e) {
      logUtils.debugInfo(['关闭叉形状校验异常：{}', e])
      return null
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
    // 微信小游戏类广告统一不看：挽留弹窗直接「放弃不看/残忍离开」
    if (this._miniGameAd) {
      if (this.giveUpWatchIfPresent()) {
        this.pushLog('微信小游戏类广告，挽留弹窗已放弃')
      }
      return false
    }
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
   * 是否显示「恭喜获得」奖励弹窗
   * （跳转类广告返回后 / 小程序类广告层层返回后 都会停在这个弹窗，下方常带「观看视频后开启」）
   */
  this.rewardDialogVisible = function () {
    return !!widgetUtils.widgetGetOne('恭喜.{0,6}(获得|领取|奖励)|奖励.{0,4}(已|到账)', 800, false, true)
  }

  /**
   * 点「跳过」文字，找不到再识图找右上角关闭叉
   * @returns {boolean} 是否成功点击
   */
  this.clickSkipOrClose = function () {
    let skip = widgetUtils.widgetGetOne('^跳过$|跳过广告|跳过此广告', 800, false, true)
    if (skip && automator.checkCenterClickable(skip)) {
      this.pushLog('点击「跳过」')
      automator.clickCenter(skip)
      sleep(800)
      return true
    }
    let tpl = this.findCloseByTemplate()
    if (tpl) {
      this.pushLog('识图找到关闭叉，点击')
      this.clickByBounds(tpl, '关闭叉(识图)')
      sleep(800)
      return true
    }
    return false
  }

  /**
   * 是否出现「已达上限」（每日看视频/惊喜礼包次数用完时的短暂提示）
   */
  this.reachLimitVisible = function () {
    return !!widgetUtils.widgetGetOne('已达上限|已达今日上限|已到达上限|达到上限|次数已用完|次数用完|明天再来', 400, false, true)
  }

  /**
   * 高频抓「已达上限」：提示只闪现约1秒，用极短超时轮询（Toast 型提示无障碍读不到时走 OCR 兜底）
   * @param {Number} ms 总检测窗口（默认1500ms，不要拉长：点完要尽快判定）
   * @returns {Boolean} 是否命中
   */
  this.checkReachLimitFast = function (ms) {
    ms = ms || 1300
    let start = new Date().getTime()
    let ocrCount = 0
    while (new Date().getTime() - start < ms) {
      if (this.reachLimitVisibleFast()) {
        return true
      }
      // 控件读不到（Toast）时，用下半屏 OCR 兜底两次（约 0.15s / 0.6s，覆盖提示闪现时段）
      let elapsed = new Date().getTime() - start
      if (ocrCount < 2) {
        let need = ocrCount == 0 ? 150 : 600
        if (elapsed >= need) {
          ocrCount++
          if (this.reachLimitByOcr()) {
            return true
          }
        }
      }
      sleep(60)
    }
    return false
  }

  /**
   * 极短超时（50ms）查「上限」控件，保证轮询高频不阻塞
   */
  this.reachLimitVisibleFast = function () {
    let keys = ['上限', '次数已用完', '次数用完', '明天再来', '已达']
    for (let i = 0; i < keys.length; i++) {
      try {
        let el = selector().textContains(keys[i]).findOne(50)
        if (el) {
          this.pushLog('命中「已达上限」提示（控件，关键词：' + keys[i] + '）：' + (el.text() || ''))
          return true
        }
      } catch (e) {
        // 忽略
      }
    }
    return false
  }

  /**
   * OCR 兜底识别下半屏「已达上限」文字
   */
  this.reachLimitByOcr = function () {
    if (!localOcrUtil.enabled) {
      return false
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return false
    }
    let top = Math.floor(config.device_height * 0.4)
    let finds = null
    try {
      // region 为 [x, y, width, height]，高度按剩余空间计算，避免越界
      finds = localOcrUtil.recognizeWithBounds(screen, [0, top, config.device_width, config.device_height - top])
    } catch (e) {
      logUtils.debugInfo(['OCR识别上限提示异常：{}', e])
      return false
    }
    if (!finds || finds.length == 0) {
      return false
    }
    for (let i = 0; i < finds.length; i++) {
      let label = finds[i].label || ''
      if (/上限|次数已用完|次数用完|明天再来/.test(label)) {
        this.pushLog('命中「已达上限」提示（OCR）：' + label)
        return true
      }
    }
    return false
  }

  /**
   * 点击「观看视频后开启」并立即检测「已达上限」
   * 达上限提示只出现很短时间（约1秒），所以点完马上高频轮询 1.5 秒；命中则返回键关闭弹窗并置 _reachLimit
   * @param {Object} btn 按钮控件
   * @param {String} desc 日志描述
   * @returns {boolean} 是否点击成功
   */
  this.clickNextAdAndCheckLimit = function (btn, desc) {
    if (!this.clickBtn(btn, desc)) {
      return false
    }
    if (this.checkReachLimitFast(1300)) {
      this.pushLog('检测到「已达上限」，本次广告次数已用完，关闭弹窗结束')
      this._reachLimit = true
      try {
        automator.back()
      } catch (e) {
        // 忽略
      }
      sleep(800)
      this.closePopup()
    } else {
      this.pushLog('未捕获「已达上限」（1.3秒内控件/OCR 未命中），按正常广告继续')
    }
    return true
  }

  /**
   * 右上角是否显示「奖励将于N秒后发放」——出现即说明这条广告可以看满，优先于跳转按钮
   */
  this.rewardCountdownVisible = function () {
    let topRegion = m => m.boundsInside(config.device_width * 0.3, 0, config.device_width, config.device_height * 0.35)
    let btn = widgetUtils.widgetGetOne('(奖励将于|\\d+\\s*(秒|s).{0,8}(发放|领取|拿奖励|领奖励|可直接))', 900, true, true, topRegion)
    if (btn && btn.content) {
      if (isRewardCountdownText(btn.content) || /奖励将于/.test(btn.content)) {
        this.pushLog('右上角识别到可看满提示：' + btn.content)
        return true
      }
    }
    return false
  }

  /**
   * OCR 兜底确认页面上是否存在「N秒后可拿奖励」看满文案（这类文案常是图片，控件读不到）
   */
  this.rewardCountdownByOcr = function () {
    if (!localOcrUtil.enabled) {
      return false
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return false
    }
    let finds = null
    try {
      // region 语义为 [x, y, width, height]，y+height 不能超过屏幕高度
      finds = localOcrUtil.recognizeWithBounds(screen, [0, 0, config.device_width, Math.floor(config.device_height * 0.35)])
    } catch (e) {
      logUtils.debugInfo(['OCR确认看满文案异常：{}', e])
      return false
    }
    if (!finds || finds.length == 0) {
      return false
    }
    for (let i = 0; i < finds.length; i++) {
      let label = finds[i].label || ''
      if (isRewardCountdownText(label)) {
        this.pushLog('OCR确认可看满文案：' + label)
        return true
      }
    }
    return false
  }

  /**
   * 奖励弹窗下方若还有「观看视频后开启」，点击继续看下一条广告
   * （点完立即检测「已达上限」，达上限则不继续）
   * @returns {boolean} 是否点击并需要继续
   */
  this.continueIfNextAdButton = function () {
    let btn = this.findNextAdButton()
    if (!btn) {
      return false
    }
    this.waitBetweenAds()
    this.pushLog('奖励弹窗下方还有「观看视频」，继续看下一条广告')
    if (!this.clickNextAdAndCheckLimit(btn, '观看视频后开启(续)')) {
      return false
    }
    this._needNextAd = !this._reachLimit
    return this._needNextAd
  }

  /**
   * 当前是否在微信（小程序 / 小游戏类广告都落在微信里）
   */
  this.isWechatForeground = function () {
    try {
      return commonFunctions.myCurrentPackage() == 'com.tencent.mm'
    } catch (e) {
      return false
    }
  }

  /**
   * 是否是微信小游戏类广告（这类广告统一不看）
   */
  this.isMiniGameAd = function () {
    if (!this.isWechatForeground()) {
      return false
    }
    return !!widgetUtils.widgetGetOne('(小游戏|玩一玩|开始游戏|游戏中心|下载游戏|立即试玩)', 800, false, true)
  }

  /**
   * 处理微信类广告：
   * - 小游戏：统一不看，点跳过/叉，挽留弹窗选「放弃不看」
   * - 小程序：多层嵌套、包名返回无效，连续按返回键（最多10次）直到出现「恭喜获得」
   * @returns {boolean} 是否已处理
   */
  this.handleWechatAd = function () {
    if (this.isMiniGameAd()) {
      this.pushLog('识别到微信小游戏类广告，统一不看')
      this._miniGameAd = true
      this.giveUpMiniGame()
      return true
    }
    this.pushLog('识别到小程序类广告，连续按返回键直到出现「恭喜获得」')
    this.backUntilRewardDialog(10)
    return true
  }

  /**
   * 小程序类广告：连续按返回键直到「恭喜获得」弹窗出现
   * @param {Number} maxTimes 最大返回次数（默认10）
   * @returns {boolean} 是否出现了恭喜获得弹窗
   */
  this.backUntilRewardDialog = function (maxTimes) {
    maxTimes = maxTimes || 10
    for (let i = 0; i < maxTimes; i++) {
      if (this.rewardDialogVisible()) {
        this.pushLog('出现「恭喜获得」弹窗，停止返回')
        return true
      }
      // 已经返回云宝宝赚云币页：说明广告/小程序早退出了，不要再按返回把应用退到桌面
      if (commonFunctions.myCurrentPackage() == _package_name && this.isOnCoinPage()) {
        this.pushLog('已返回云宝宝赚云币页，停止返回')
        return true
      }
      this.pushLog('小程序广告：按返回键第' + (i + 1) + '次')
      try {
        automator.back()
      } catch (e) {
        // 忽略
      }
      sleep(1200)
      if (this.rewardDialogVisible()) {
        this.pushLog('返回后出现「恭喜获得」弹窗')
        return true
      }
    }
    this.pushWarningLog('连续返回' + maxTimes + '次仍未出现「恭喜获得」，改为查找跳过/关闭叉')
    if (this.clickSkipOrClose()) {
      return true
    }
    this.backToYunbaobao()
    return false
  }

  /**
   * 挽留弹窗里选「放弃不看 / 残忍离开 / 关闭广告」（微信小游戏类广告统一用这个）
   */
  this.giveUpWatchIfPresent = function () {
    let names = ['^放弃不看$', '放弃不看', '^残忍离开$', '残忍离开', '^关闭广告$']
    for (let i = 0; i < names.length; i++) {
      let btn = widgetUtils.widgetGetOne(names[i], 600, false, true)
      if (btn && automator.checkCenterClickable(btn)) {
        this.pushLog('挽留弹窗选择「' + (btn.content || names[i]) + '」')
        automator.clickCenter(btn)
        sleep(800)
        return true
      }
    }
    return false
  }

  /**
   * 微信小游戏类广告：点跳过 / 关叉关闭，挽留弹窗直接放弃
   */
  this.giveUpMiniGame = function () {
    if (this.clickSkipOrClose()) {
      this.giveUpWatchIfPresent()
      return true
    }
    if (this.giveUpWatchIfPresent()) {
      return true
    }
    return this.closeAdIfPossible(false, true)
  }

  /**
   * 读取「每日看视频10次」的任务进度（如 每日看视频10次(3/10) => 3）
   * @returns {Number} 已看次数，未识别返回 -1
   */
  this.readDailyWatchProgress = function () {
    let list = widgetUtils.widgetGetAll('每日看视频10次', 1200, true)
    if (!list || list.length == 0) {
      return -1
    }
    for (let i = 0; i < list.length; i++) {
      let candidates = []
      try {
        candidates.push(list[i].content || '')
        candidates.push((list[i].text && list[i].text()) || '')
        let parent = list[i].parent()
        if (parent) {
          candidates.push((parent.text && parent.text()) || '')
        }
      } catch (e) {
        // 忽略
      }
      for (let c = 0; c < candidates.length; c++) {
        let m = /每日看视频\s*10\s*次[^0-9]{0,3}(\d+)\s*\/\s*10/.exec(candidates[c] || '')
        if (m) {
          this.pushLog('每日看视频进度：' + m[1] + '/10')
          return parseInt(m[1])
        }
      }
    }
    return -1
  }

  /**
   * 检测点击「进行中」后短暂出现的「任务已完成」提示（约1秒后出现、约2秒后消失）
   * @param {Number} seconds 监测时长（秒）
   * @returns {boolean} 是否出现
   */
  this.checkTaskCompletedHint = function (seconds) {
    let start = new Date().getTime()
    while (new Date().getTime() - start < seconds * 1000) {
      if (widgetUtils.widgetGetOne('任务已完成|任务完成|今日已完成', 400, false, true)) {
        this.pushLog('检测到「任务已完成」提示')
        return true
      }
      sleep(300)
    }
    return false
  }

  /**
   * 第一次进入赚云币页的「签到成功」弹窗：下方有「额外领取云币」按钮，点了看一次广告，看完回点「我知道了」
   * @returns {boolean} 是否处理了该弹窗
   */
  this.handleSignSuccessBonusDialog = function () {
    let bonusBtn = widgetUtils.widgetGetOne('额外领取.{0,4}云币|额外领取', 2500, false, true)
    if (!bonusBtn) {
      return false
    }
    this.pushLog('检测到签到成功弹窗，点击「额外领取云币」看广告')
    if (!this.clickBtn(bonusBtn, '额外领取云币')) {
      this.pushWarningLog('「额外领取云币」点击失败')
      return false
    }
    sleep(1500)
    // 签到额外领取一般就一次：不在弹窗里接着看下一条，避免卡在这条上太久
    this.watchAd('签到额外奖励', { allowChainNextAd: false })
    // 广告看完后会回到签到成功弹窗，点「我知道了」收尾
    let know = widgetUtils.widgetGetOne('我知道了|知道了', 3000, false, true)
    if (know && automator.checkCenterClickable(know)) {
      this.pushLog('点击签到弹窗「我知道了」')
      automator.clickCenter(know)
      sleep(800)
    }
    return true
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
