/*
 * 淘金币日常（淘金币签到 + 任务面板领金币）
 *
 * 旧版判据（点击签到 / 明天可领 / 购物返 / 88VIP）在现在的淘宝上基本已经失效：
 * 现在的淘金币是一个「今日速赚 / 更多金币等你赚 / 更多专享福利」的任务面板，
 * 签到本身也只是面板里的一行按钮。这里按 MiaoTask 后端（uiautomator2 侧）已经
 * 验证过的页面词表重写判据：
 *   backend/app/taobao/activities/coins/config.json  入口、面板标记、展开、浏览计秒、跨应用停留
 *   backend/app/taobao/utils/daily.py                弹窗关闭、硬拦截、按行解析、补扫
 *   backend/app/taobao/utils/task_rules.py           动作按钮词表、跨应用包名
 *   backend/app/taobao/utils/actions.py              浏览/跳转/点商品/施肥浇水
 *   backend/app/taobao/utils/search.py               搜索入口与提交
 *
 * 框架约定不变：module.exports 为 BaseSignRunner 实例，exec() 由 MainExecutor 调用，
 * 单任务上限 10 分钟（本脚本自设 8 分钟预算，留出收尾时间）。
 */
let { config } = require('../config.js')(runtime, this)
let singletonRequire = require('../lib/SingletonRequirer.js')(runtime, this)
let commonFunctions = singletonRequire('CommonFunction')
let widgetUtils = singletonRequire('WidgetUtils')
let automator = singletonRequire('Automator')
let logUtils = singletonRequire('LogUtils')
let localOcrUtil = require('../lib/LocalOcrUtil.js')

let BaseSignRunner = require('./BaseSignRunner.js')

const PACKAGE_NAME = 'com.taobao.taobao'

// 淘金币面板/列表标记（coins/config.json daily_page.list_markers）
const PANEL_MARKERS = /赚金币抵钱|今日累计奖励|金币任务|今日速赚|更多金币等你赚|更多专享福利|收起更多任务/
// 淘金币落地页标记（coins/config.json daily_page.landing_markers）
const LANDING_MARKERS = /淘金币首页|升级赛车拿钱|赚更多金币|日常版/
// 任务行右侧动作按钮词表（daily.py ACTION_RE + daily.py DAILY_CLAIMS）
const ACTION_TEXT = /^(?:去完成|去浏览|去逛逛|去看看|去看一看|看一看|点一点|去瞧瞧|瞧瞧|立即看看|去查看|立即查看|去体验|去搜索|去观看|去参与|去领取|去领币|去领钱|去领现金|去抢|立即抢|去逛逛领|领取奖励|立即领取|领奖励|立即领|马上领|去领|领取|签到|立即签到|点击签到|点击领取|领肥料|收下奖励|去签到|逛一逛|搜一下|领取任务|去答题|去邀请|去玩|已完成|已领取|明日再来|今日已签到|已签到|[0-9]{1,2}点可领)$/
// 已完成的按钮（daily.py DONE_ACTIONS）
const DONE_TEXT = /^(?:已完成|已领取|明日再来|今日已签到|已签到)$/
// 领取类按钮（daily.py DAILY_CLAIMS）
const CLAIM_TEXT = /^(?:去领取|领取奖励|立即领取|领奖励|立即领|马上领|去领|领取|签到|立即签到|点击签到|点击领取|领肥料|收下奖励|去签到)$/
// 弹窗关闭按钮（daily.py POPUP_CLOSE_RE；刻意去掉「收起」，那是面板自己的折叠按钮）
const POPUP_CLOSE_TEXT = /^(?:×|✕|✖|╳|㐅|关闭|关闭弹窗|关闭窗口|关闭浮层|我知道了|知道了|知道啦|以后再说|稍后再说|稍后|暂不开启|暂不需要|暂不|不感兴趣|跳过|下次再说|不再提醒|点此关闭|点击关闭)$/
// 浮层内容提示（daily.py POPUP_HINT_RE）
const POPUP_HINT_TEXT = /恭喜|抢到|获得|奖励|红包|优惠券|折扣券|入会|权益|开通|绑定|升级|活动规则|邀请|已领取|翻倍|提醒|弹窗|完成任务|限本直播间|领取并使用/
// 硬风险（daily.py HARD_RISK_RE）。施肥/浇水在这里是兜底，
// 摇钱树的「点一下施肥」在 classifyTask 里先被豁免，不会被这条拦掉。
const HARD_RISK_TEXT = /下单|购买|支付|充值|开通|订阅|邀|拉人|助力|授权|实名|下载|安装|施肥|浇水|兑换|提现|拍照|拍摄|答题|考试/
// 软风险（daily.py SOFT_RISK_RE）：只有小字写明「点击去逛/浏览N秒」时才代做
const SOFT_RISK_TEXT = /抽赏|抽奖|夺宝|关注|收藏|加购|拍立淘|[0-9]+件商品/
// 小字可点判据（task_rules.py ACTIONABLE_DETAIL_RE）
const ACTIONABLE_DETAIL_TEXT = /点击|浏览[0-9]+[秒sS个]|观看[0-9]+[秒sS]|停留[0-9]+[秒sS]|逛一逛|逛逛|去逛|看一看|搜一搜|搜索|滑动|下滑|查看/
// 进度标记 (1/1)（task_rules.py PROGRESS_RE）
const PROGRESS_TEXT = /[(（\[]\s*\d+\s*\/\s*\d+\s*[)）\]]/
// 浏览完成提示（actions.py browse_destination）
const BROWSE_DONE_TEXT = /任务已完成|浏览已完成|浏览完成|完成浏览|奖励已到账|恭喜完成|任务完成啦/
// 直播页固定话术（daily.py LIVE_PAGE_RE）
const LIVE_PAGE_TEXT = /正在直播|\d+\s*人观看|说点什么|直播间|点赞/

// 跨应用停留下限（coins/config.json daily_page.app_visit_seconds）
const APP_FLOORS = {
  '百度极速版': 15, '天猫': 12, '淘宝直播': 12, '支付宝': 10,
  '闲鱼': 12, '京东': 12, '拼多多': 12, '头条': 20
}
// 跨应用包名（task_rules.py EXTERNAL_APPS，只保留本机可能用到的主包名）
const APP_PACKAGES = {
  '天猫': ['com.tmall.wireless'],
  '淘宝直播': ['com.taobao.live'],
  '支付宝': ['com.eg.android.AlipayGphone'],
  '闲鱼': ['com.taobao.idlefish'],
  '京东': ['com.jingdong.app.mall'],
  '拼多多': ['com.xunmeng.pinduoduo'],
  '百度极速版': ['com.baidu.searchbox.lite'],
  '头条': ['com.ss.android.article.news', 'com.ss.android.article.lite'],
  '快手': ['com.smile.gifmaker', 'com.kuaishou.nebula'],
  '微博': ['com.sina.weibo', 'com.sina.weibolite'],
  '抖音': ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.aweme.lite'],
  'UC': ['com.UCMobile', 'com.ucmobile'],
  '优酷': ['com.youku.phone'],
  '高德': ['com.autonavi.minimap'],
  '菜鸟': ['com.cainiao.wireless']
}

// 本脚本的可调参数
const OPTIONS = {
  maxMinutes: 8,                 // 单次执行预算，框架还有 10 分钟兜底
  maxRounds: 30,                 // 面板轮次上限，防止列表刷新异常时死循环
  defaultBrowseSeconds: 8,       // 没写「浏览N秒」时的浏览时长
  defaultVisitSeconds: 10,       // 跨应用跳转的最小停留
  browseExtraSeconds: 2,         // 计时结束后多留一点，等奖励到账
  maxAttemptsPerTask: 2,         // 同一行最多尝试次数
  maxExpandTimes: 2,             // 「展开」最多点几次
  enable88Vip: true              // 可选：88VIP 每日签到（后端没有这块流程，失败不影响主流程）
}
// 入口搜索词（对齐 backend/app/taobao/configs/base.json 的 search_keyword / task_search_keyword）
// config.js 里目前没有这两个字段，需要改时在 config.js 增加同名键即可覆盖
const KEYWORD_ENTRY = config.taobao_entry_keyword || '淘金币'
const KEYWORD_TASK = config.taobao_task_keyword || '手机壳'

/** 去掉空白后的文本，用于匹配按钮/标记 */
function clean (text) {
  return (text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, '')
}
/**
 * 按钮文字归一：OCR 有时会把旁边的「+20」奖励或箭头一起读进同一个控件，
 * 这里先剥掉，剩下的才是真正的动作词（去完成 / 领取 / 已签到 …）
 */
function actionOf (text) {
  let value = clean(text)
  value = value.replace(/[>〉›»]+$/g, '')
  value = value.replace(/[+＋][0-9]+(?:\.[0-9]+)?(?:金币|元)?$/g, '')
  return value.replace(/[>〉›»]+$/g, '')
}
/** 是否包含中文 */
function chinese (text) {
  return /[\u4e00-\u9fa5]/.test(text || '')
}
/** 统一 bounds 成 {x1,y1,x2,y2}，兼容 Rect 与 [x,y,w,h] */
function rectOf (bounds) {
  if (!bounds) {
    return null
  }
  let x1, y1, x2, y2
  if (typeof bounds.left === 'number') {
    x1 = bounds.left
    y1 = bounds.top
    x2 = bounds.right
    y2 = bounds.bottom
  } else if (typeof bounds[0] === 'number' && typeof bounds.length === 'number' && bounds.length >= 4) {
    x1 = bounds[0]
    y1 = bounds[1]
    x2 = x1 + bounds[2]
    y2 = y1 + bounds[3]
  } else {
    return null
  }
  if (!(x2 > x1) || !(y2 > y1)) {
    return null
  }
  return { x1: x1, y1: y1, x2: x2, y2: y2 }
}
/** 把文本+bounds 包装成统一的节点对象 */
function nodeOf (text, bounds) {
  let rect = rectOf(bounds)
  if (!rect) {
    return null
  }
  let content = (text || '').replace(/\u00a0/g, ' ').trim()
  if (!content) {
    return null
  }
  return {
    text: content,
    x1: rect.x1,
    y1: rect.y1,
    x2: rect.x2,
    y2: rect.y2,
    cx: (rect.x1 + rect.x2) / 2,
    cy: (rect.y1 + rect.y2) / 2
  }
}

function SignRunner () {
  BaseSignRunner.call(this)
  const _this = this
  this.startTime = 0
  this.panelReached = false
  this.progressCount = 0
  this.signInDone = false
  this.noMoreTasks = false
  this.remainingCount = 0
  this.expandTimes = 0
  this.installedCache = null

  /* ======================== 基础工具 ======================== */

  this.withinBudget = function () {
    return new Date().getTime() - _this.startTime < OPTIONS.maxMinutes * 60000
  }

  this.currentPackage = function () {
    try {
      return commonFunctions.myCurrentPackage() || ''
    } catch (e) {
      return ''
    }
  }

  this.isInTaobao = function () {
    return _this.currentPackage() === PACKAGE_NAME
  }

  /**
   * 打印当前页面文本（找不到入口/按钮时用来比对页面是否又改版了）
   */
  this.logVisibleTexts = function (tag) {
    try {
      let nodes = _this.uiNodes()
      let texts = []
      nodes.forEach(function (n) {
        if (texts.indexOf(n.text) < 0) {
          texts.push(n.text)
        }
      })
      _this.pushLog(tag + ' 可见文本（前25条）：' + texts.slice(0, 25).join(' | '))
    } catch (e) {
      logUtils.debugInfo(['打印 ' + tag + ' 页面文本失败：{}', e])
    }
  }

  this.clickNode = function (node, desc) {
    if (!node) {
      _this.pushWarningLog('未找到可点击目标：' + (desc || ''))
      return false
    }
    try {
      automator.click(Math.round(node.cx), Math.round(node.cy))
      _this.pushLog('点击 ' + (desc || node.text) + ' (' + Math.round(node.cx) + ',' + Math.round(node.cy) + ')')
      sleep(800)
      return true
    } catch (e) {
      _this.pushWarningLog('点击 ' + (desc || node.text) + ' 失败：' + e)
      return false
    }
  }

  this.clickWidget = function (regex, desc, timeout) {
    let widget = null
    try {
      widget = widgetUtils.widgetGetOne(regex, timeout || 1500, false, true)
    } catch (e) {
      logUtils.debugInfo(['控件查找失败：{}', e])
    }
    if (!widget) {
      return false
    }
    try {
      if (automator.checkCenterClickable(widget)) {
        automator.clickCenter(widget)
      } else {
        let bounds = widget.bounds()
        automator.click(Math.round(bounds.centerX()), Math.round(bounds.centerY()))
      }
      _this.pushLog('点击 ' + (desc || String(regex)))
      sleep(800)
      return true
    } catch (e) {
      _this.pushWarningLog('点击 ' + (desc || String(regex)) + ' 失败：' + e)
      return false
    }
  }

  this.clickRow = function (row, desc) {
    let anchor = row.anchorNode
    // 只有奖励圈（+20 / 已领取）的行，点奖励圈不一定触发任务，优先点标题
    if (anchor && /^[+＋]/.test(clean(anchor.text)) && row.captionNode) {
      anchor = row.captionNode
    }
    if (anchor && _this.clickNode(anchor, desc)) {
      return true
    }
    if (row.anchorNode && row.anchorNode !== anchor && _this.clickNode(row.anchorNode, (desc || '') + '（奖励圈兜底）')) {
      return true
    }
    if (row.captionNode && row.captionNode !== anchor && _this.clickNode(row.captionNode, (desc || '') + '（标题兜底）')) {
      return true
    }
    return false
  }

  /* ======================== 读屏 ======================== */

  this.uiNodes = function () {
    let nodes = []
    try {
      let views = className('android.widget.TextView').find()
      views.forEach(function (view) {
        try {
          let node = nodeOf(view.text(), view.bounds())
          if (node) {
            nodes.push(node)
          }
        } catch (e) {
          // 单个控件读取失败忽略
        }
      })
    } catch (e) {
      logUtils.debugInfo(['读取控件文本失败：{}', e])
    }
    return nodes
  }

  this.ocrNodes = function (region) {
    if (!localOcrUtil.enabled) {
      return []
    }
    let screen = commonFunctions.captureScreen()
    if (!screen) {
      return []
    }
    let finds = []
    try {
      // 不传 region（传 null 在部分 OCR 实现里会当成数组去取下标而报错）
      finds = region ? localOcrUtil.recognizeWithBounds(screen, region) : localOcrUtil.recognizeWithBounds(screen)
    } catch (e) {
      logUtils.debugInfo(['OCR 识别失败：{}', e])
      return []
    }
    let nodes = []
    ;(finds || []).forEach(function (item) {
      let node = nodeOf(item.label, item.bounds)
      if (node) {
        nodes.push(node)
      }
    })
    return nodes
  }

  /**
   * 读取当前画面的文本节点。优先用 OCR：淘金币是 WebView 页面，控件树里经常
   * 只挂着一层壳，OCR 拿到的是“画面上真正看见的字”（daily.py read() 的取舍）。
   * OCR 不可用或识别为空时退回控件树。
   */
  this.readNodes = function (useUiFirst) {
    let ui = []
    if (useUiFirst) {
      ui = _this.uiNodes()
      if (ui.length >= 6) {
        return ui
      }
    }
    if (localOcrUtil.enabled) {
      let ocr = _this.ocrNodes()
      if (ocr.length > 0) {
        return ocr
      }
    }
    return ui.length > 0 ? ui : _this.uiNodes()
  }

  this.matches = function (nodes, regex) {
    let pattern = regex instanceof RegExp ? regex : new RegExp(regex)
    let hits = []
    ;(nodes || []).forEach(function (node) {
      if (pattern.test(clean(node.text))) {
        hits.push(node)
      }
    })
    return hits
  }

  this.hasText = function (nodes, regex) {
    return _this.matches(nodes, regex).length > 0
  }

  /* ======================== 页面判定 ======================== */

  this.isTaskPanel = function (nodes) {
    nodes = nodes || _this.readNodes()
    if (!nodes || nodes.length === 0) {
      return false
    }
    return _this.hasText(nodes, PANEL_MARKERS)
  }

  this.isCoinLanding = function (nodes) {
    return _this.hasText(nodes || _this.readNodes(), LANDING_MARKERS)
  }

  /**
   * 首页判据同 daily.py homepage_visible：底部同时有「我的淘宝」「购物车」
   */
  this.isHomepage = function (nodes) {
    nodes = nodes || _this.readNodes()
    let height = config.device_height
    let bottomHas = function (label) {
      return _this.matches(nodes, new RegExp(label)).some(function (node) {
        return node.cy > height * 0.8
      })
    }
    return bottomHas('我的淘宝') && bottomHas('购物车')
  }

  /**
   * 任务清单和弹窗长得很像（都有 ✕、都有「奖励」），区别是清单里有多行动作按钮。
   * 见 daily.py looks_like_task_panel：满屏 ✕ 不能当弹窗关，否则会把整张面板关掉。
   */
  this.actionButtons = function (nodes) {
    let buttons = []
    ;(nodes || []).forEach(function (node) {
      if (ACTION_TEXT.test(actionOf(node.text))) {
        buttons.push(node)
      }
    })
    return buttons
  }

  this.looksLikeTaskPanel = function (nodes) {
    return _this.actionButtons(nodes).length >= 2
  }

  /**
   * 行解析失败（OCR 把整行读成一串）时的兜底：只点右侧的通用动作按钮。
   * 答题/邀请/抢购这类点进去只是开个页面、不能自动完成，排除掉免得白跑。
   */
  this.blindClickButtons = function (nodes) {
    let width = config.device_width
    let height = config.device_height
    let buttons = []
    _this.actionButtons(nodes).forEach(function (node) {
      if (node.cx < width * 0.5) {
        return
      }
      if (node.y2 - node.y1 >= height * 0.1) {
        return
      }
      let action = actionOf(node.text)
      if (DONE_TEXT.test(action)) {
        return
      }
      if (/去答题|去邀请|去抢|立即抢|去玩|去下单/.test(action)) {
        return
      }
      buttons.push(node)
    })
    return buttons
  }

  /* ======================== 启动与导航 ======================== */

  /**
   * 启动/跳转时可能出现「打开 / 仅本次 / 允许」确认窗
   */
  this.handleJumpDialog = function () {
    let handled = false
    ;['^打开$', '^仅本次$', '^仅打开一次$', '^允许$', '^打开应用$', '^继续前往$', '^仍要打开$'].forEach(function (pattern) {
      if (_this.clickWidget(pattern, '跳转确认 ' + pattern, 1200)) {
        handled = true
      }
    })
    return handled
  }

  this.launchTaobao = function () {
    _this.pushLog('打开淘宝')
    try {
      commonFunctions.launchPackage(PACKAGE_NAME)
    } catch (e) {
      try {
        app.launch(PACKAGE_NAME)
      } catch (e2) {
        _this.pushWarningLog('启动淘宝失败：' + e2)
      }
    }
    sleep(2500)
    _this.handleJumpDialog()
    sleep(1200)
    return _this.isInTaobao()
  }

  /**
   * 回到淘宝首页（88VIP / 任务页残留时先退出来）
   */
  this.ensureHomepage = function () {
    for (let i = 0; i < 3; i++) {
      let nodes = _this.readNodes()
      if (_this.isTaskPanel(nodes) || _this.isHomepage(nodes)) {
        return true
      }
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
        continue
      }
      automator.back()
      sleep(1500)
    }
    return _this.isHomepage(_this.readNodes())
  }

  /**
   * 点首页频道里的「领淘金币 / 淘金币」入口（控件优先，OCR 兜底）
   */
  this.tapCoinEntry = function (nodes) {
    let widget = null
    try {
      widget = widgetUtils.widgetGetOne(/^(?:去|进入|领|领一下)?淘金币[>〉]?$/, 2000, false, true)
    } catch (e) {
      logUtils.debugInfo(['查找淘金币入口控件失败：{}', e])
    }
    if (widget) {
      try {
        let bounds = widget.bounds()
        automator.click(Math.round(bounds.centerX()), Math.round(bounds.centerY()))
        _this.pushLog('点击首页频道「' + (widget.text() || '淘金币') + '」')
        sleep(1000)
        return true
      } catch (e) {
        _this.pushWarningLog('点击淘金币频道失败：' + e)
      }
    }
    let width = config.device_width
    let height = config.device_height
    let candidates = []
    _this.matches(nodes || _this.readNodes(), /^(?:去|进入|领|领一下)?淘金币[>〉]?$/).forEach(function (node) {
      // 避开状态栏与底部导航，商品标题里也可能出现淘金币
      if (node.cy < height * 0.12 || node.cy > height * 0.9) {
        return
      }
      if (node.cx < width * 0.03 || node.cx > width * 0.97) {
        return
      }
      candidates.push(node)
    })
    if (candidates.length > 0) {
      candidates.sort(function (a, b) {
        return a.cy - b.cy
      })
      return _this.clickNode(candidates[0], '淘金币入口（OCR）')
    }
    return false
  }

  this.inputKeyword = function (keyword) {
    try {
      let edit = className('android.widget.EditText').findOne(1500)
      if (edit) {
        edit.setText(keyword)
        _this.pushLog('输入关键词：' + keyword)
        sleep(600)
        return true
      }
    } catch (e) {
      logUtils.debugInfo(['查找搜索输入框失败：{}', e])
    }
    try {
      setText(0, keyword)
      _this.pushLog('输入关键词（无输入框兜底）：' + keyword)
      sleep(600)
      return true
    } catch (e) {
      _this.pushWarningLog('输入关键词失败：' + e)
    }
    return false
  }

  /**
   * 提交搜索：只认右上角那个窄的「搜索」按钮（search.py _submit_buttons）
   */
  this.submitSearch = function () {
    let width = config.device_width
    let height = config.device_height
    let buttons = []
    _this.readNodes().forEach(function (node) {
      if (clean(node.text) !== '搜索') {
        return
      }
      if (node.cx < width * 0.6 || node.cy > height * 0.25) {
        return
      }
      if (node.x2 - node.x1 >= width * 0.3) {
        return
      }
      buttons.push(node)
    })
    if (buttons.length > 0) {
      buttons.sort(function (a, b) {
        return b.cx - a.cx
      })
      return _this.clickNode(buttons[0], '提交搜索')
    }
    return _this.clickWidget('^搜索$', '提交搜索（控件兜底）', 1500)
  }

  /**
   * 首页找不到入口时用搜索兜底：搜索「淘金币」→ 结果里的官方频道卡片 → 落地页
   */
  this.openCoinBySearch = function () {
    let width = config.device_width
    let height = config.device_height
    _this.pushLog('首页未找到淘金币入口，改用搜索进入')
    let nodes = _this.readNodes()
    let box = null
    _this.matches(nodes, /^搜索栏$|^搜索框$|^搜索宝贝$|^搜索商品$|^搜索$/).forEach(function (node) {
      if (node.cy > height * 0.25 || node.cx > width * 0.8) {
        return
      }
      if (!box || node.cy < box.cy) {
        box = node
      }
    })
    if (box) {
      _this.clickNode(box, '首页搜索框')
    } else if (!_this.clickWidget(/^搜索栏$|^搜索框$/, '首页搜索框（控件兜底）', 1500)) {
      return false
    }
    sleep(1500)
    if (!_this.inputKeyword(KEYWORD_ENTRY)) {
      return false
    }
    _this.submitSearch()
    sleep(2500)
    // 结果页里的官方频道卡片：领淘金币 / 淘金币
    let results = _this.readNodes()
    let cards = []
    _this.matches(results, /^(?:去|进入|领|领一下)?淘金币[>〉]?$/).forEach(function (node) {
      if (node.cy > height * 0.45) {
        return
      }
      cards.push(node)
    })
    if (cards.length === 0) {
      _this.pushWarningLog('搜索结果里没有找到淘金币入口')
      return false
    }
    cards.sort(function (a, b) {
      return a.cy - b.cy
    })
    _this.clickNode(cards[0], '搜索结果淘金币入口')
    sleep(2500)
    return true
  }

  /**
   * 等任务面板出现（点完入口/任务入口后页面还要加载一会儿）
   */
  this.waitForPanel = function (timeout) {
    let end = new Date().getTime() + (timeout || 6000)
    let nodes = _this.readNodes()
    while (true) {
      if (_this.isTaskPanel(nodes)) {
        _this.panelReached = true
        return true
      }
      if (new Date().getTime() > end) {
        return false
      }
      sleep(1200)
      nodes = _this.readNodes()
    }
  }

  /**
   * 处理淘金币落地页：活动版回日常版，再去任务面板
   */
  this.handleCoinLanding = function (nodes) {
    nodes = nodes || _this.readNodes()
    if (_this.isTaskPanel(nodes)) {
      _this.panelReached = true
      return true
    }
    // 「回日常版 / 日常版」：活动版页面回到日常版面板
    let daily = _this.matches(nodes, /^(?:回)?日常版$|^回日常版[>〉]?$/)
    if (daily.length > 0) {
      _this.clickNode(daily[0], '回日常版')
      if (_this.waitForPanel(6000)) {
        return true
      }
    }
    // 「赚更多金币 / 去赚金币」：进任务列表（coins/config.json task_entry_labels）
    nodes = _this.readNodes()
    let taskEntry = _this.matches(nodes, /^(?:赚更多金币|去赚金币|任务中心|做任务赚金币)[>〉]?$/)
    if (taskEntry.length > 0) {
      _this.clickNode(taskEntry[0], '进入赚金币任务')
      if (_this.waitForPanel(6000)) {
        return true
      }
    }
    return _this.isTaskPanel(_this.readNodes())
  }

  this.enterCoinPage = function () {
    _this.panelReached = false
    if (!_this.isInTaobao()) {
      _this.launchTaobao()
    }
    if (_this.isTaskPanel(_this.readNodes())) {
      _this.panelReached = true
      return true
    }
    for (let i = 0; i < 3 && _this.withinBudget(); i++) {
      let nodes = _this.readNodes()
      if (_this.isTaskPanel(nodes)) {
        _this.panelReached = true
        return true
      }
      _this.dismissPopup(nodes)
      nodes = _this.readNodes()
      // 首页频道里的淘金币入口
      if (_this.tapCoinEntry(nodes)) {
        sleep(1500)
        _this.handleJumpDialog()
        if (_this.handleCoinLanding()) {
          return true
        }
      }
      // 首页入口没找到：走搜索
      if (_this.isHomepage(_this.readNodes()) && _this.openCoinBySearch()) {
        sleep(1500)
        if (_this.handleCoinLanding()) {
          return true
        }
      }
      // 退一层再试（可能停在活动版/频道页）
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
        if (_this.isTaskPanel(_this.readNodes())) {
          _this.panelReached = true
          return true
        }
      } else {
        automator.back()
        sleep(1500)
        if (_this.isTaskPanel(_this.readNodes())) {
          _this.panelReached = true
          return true
        }
      }
    }
    return false
  }

  /**
   * 从任务目的地回到淘金币面板：先关浮层，再逐层返回，最后重新进页面
   */
  this.backToPanel = function () {
    for (let i = 0; i < 4; i++) {
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
      }
      let nodes = _this.readNodes()
      if (_this.isTaskPanel(nodes)) {
        return true
      }
      // 领取后的奖励弹窗（daily.py execute 里的 reward 按钮）
      let reward = _this.matches(nodes, /^(?:收下奖励|开心收下|知道了|我知道了)$/)
      if (reward.length > 0 && !_this.isTaskPanel(nodes)) {
        _this.clickNode(reward[0], '奖励弹窗')
        sleep(1200)
        continue
      }
      if (_this.dismissPopup(nodes)) {
        continue
      }
      automator.back()
      sleep(1500)
    }
    _this.pushWarningLog('逐层返回后仍未回到淘金币面板，重新进入')
    if (_this.enterCoinPage()) {
      return _this.isTaskPanel(_this.readNodes())
    }
    return false
  }

  /* ======================== 面板操作 ======================== */

  /**
   * 点「展开」把 更多金币等你赚 的队列放出来（coins/config.json expand_label/expand_context）
   * 展开过一次之后按钮会变成「收起」，再点会把露出来的任务重新折叠，所以限次数。
   */
  this.expandPanel = function (nodes) {
    if (_this.expandTimes >= OPTIONS.maxExpandTimes) {
      return false
    }
    nodes = nodes || _this.readNodes()
    if (!_this.isTaskPanel(nodes)) {
      return false
    }
    let expand = _this.matches(nodes, /^展开[⌄⌃^＞>〉·.]*$/)
    if (expand.length === 0) {
      return false
    }
    _this.expandTimes++
    _this.pushLog('展开全部任务（第 ' + _this.expandTimes + ' 次）')
    _this.clickNode(expand[0], '展开任务列表')
    sleep(1800)
    return true
  }

  this.findCloseNode = function (nodes) {
    let height = config.device_height
    let closes = _this.matches(nodes, POPUP_CLOSE_TEXT)
    for (let i = 0; i < closes.length; i++) {
      let node = closes[i]
      let nodeHeight = node.y2 - node.y1
      // 太扁的是一行小字，顶部的是状态栏按钮，都不像浮层关闭
      if (nodeHeight <= 0 || nodeHeight > height * 0.12) {
        continue
      }
      if (node.cy < height * 0.05) {
        continue
      }
      return node
    }
    return null
  }

  /**
   * 关掉挡在页面上的浮层（daily.py dismiss_popup）：只点“关掉这层”的按钮，
   * 任务面板本身不参与，否则会把整张面板关掉。
   */
  this.dismissPopup = function (nodes) {
    nodes = nodes || _this.readNodes()
    if (_this.isTaskPanel(nodes) || _this.looksLikeTaskPanel(nodes)) {
      return false
    }
    let close = _this.findCloseNode(nodes)
    if (!close) {
      return false
    }
    if (!_this.hasText(nodes, POPUP_HINT_TEXT)) {
      // 页面上没有任何浮层内容提示时不乱点关闭
      return false
    }
    _this.pushLog('关闭弹窗：' + clean(close.text).slice(0, 12))
    _this.clickNode(close, '弹窗关闭')
    sleep(1200)
    return true
  }

  /**
   * 短距滑动：淘金币是底部浮层，一次性长滑会被当成下拉手势把浮层关掉
   * （daily.py install_swipe_guard 的分段滑动）。这里统一控制在 0.12 屏高以内。
   */
  this.shortScroll = function (up) {
    let width = config.device_width
    let height = config.device_height
    let x = Math.round(width * 0.5)
    let step = Math.round(height * 0.12)
    let from = Math.round(height * 0.62)
    if (up === false) {
      automator.swipe(x, from, x, from + step, 400)
    } else {
      automator.swipe(x, from, x, from - step, 400)
    }
    sleep(600)
  }

  this.panelSignature = function (nodes) {
    let keys = []
    _this.parseTasks(nodes).forEach(function (row) {
      keys.push(row.key + '/' + row.action)
    })
    return keys.join('|')
  }

  /**
   * 在面板里往下找更多任务。滑完已经不是面板了（浮层被关掉）就返回 false，
   * 交给上层重新进页面。
   */
  this.scrollPanel = function () {
    let beforeSig = _this.panelSignature(_this.readNodes())
    let width = config.device_width
    let height = config.device_height
    let x = Math.round(width * 0.5)
    let step = Math.round(height * 0.15)
    let from = Math.round(height * 0.78)
    automator.swipe(x, from, x, from - step, 450)
    sleep(700)
    automator.swipe(x, from - step, x, from - step * 2, 450)
    sleep(1300)
    let nodes = _this.readNodes()
    if (!_this.isTaskPanel(nodes)) {
      _this.pushWarningLog('滑动后已离开淘金币面板')
      if (!_this.backToPanel()) {
        _this.enterCoinPage()
      }
      return false
    }
    let afterSig = _this.panelSignature(nodes)
    if (afterSig === beforeSig) {
      _this.pushLog('继续下滑没有新任务')
      return false
    }
    return true
  }

  /**
   * 停在目标页面上计时，中途用短滑动让“浏览N秒”的计数继续跑
   */
  this.stayOnPage = function (seconds) {
    let end = new Date().getTime() + Math.max(1, seconds) * 1000
    let tick = 0
    while (new Date().getTime() < end && _this.withinBudget()) {
      sleep(1000)
      tick++
      // 只在淘宝内轻滑，跳到别的应用里乱滑可能触发误操作
      if (tick % 3 === 0 && _this.isInTaobao()) {
        _this.shortScroll()
      }
      if (tick % 2 === 0) {
        try {
          if (widgetUtils.widgetGetOne(BROWSE_DONE_TEXT, 600, false, true)) {
            _this.pushLog('检测到任务完成提示')
            break
          }
        } catch (e) {
          // 忽略
        }
      }
    }
  }

  /* ======================== 面板解析 ======================== */

  /**
   * 找出按钮左侧同一行里的标题和小字（caption / 浏览5秒 这类描述）
   */
  this.captionNodes = function (nodes, anchor) {
    let width = config.device_width
    let height = config.device_height
    let left = []
    nodes.forEach(function (node) {
      if (!chinese(node.text)) {
        return
      }
      if (node.x2 > anchor.x1 - width * 0.01) {
        return
      }
      if (Math.abs(node.cy - anchor.cy) > height * 0.04) {
        return
      }
      if (node.y2 - node.y1 >= height * 0.09) {
        return
      }
      if (node.cx < width * 0.03) {
        return
      }
      if (ACTION_TEXT.test(actionOf(node.text))) {
        return
      }
      left.push(node)
    })
    left.sort(function (a, b) {
      if (Math.abs(a.cy - b.cy) > height * 0.01) {
        return a.cy - b.cy
      }
      return a.x1 - b.x1
    })
    return left
  }

  this.targetApp = function (caption) {
    let app = ''
    Object.keys(APP_PACKAGES).forEach(function (name) {
      if (!app && caption.indexOf(name) >= 0) {
        app = name
      }
    })
    return app
  }

  /**
   * 任务分类：顺序对齐 daily.py classify_daily
   */
  this.classifyTask = function (caption, detail, action) {
    // 「下单最高 +X」只是额外奖励，不代表必须下单
    let safeDetail = (detail || '').replace(/下单(?:最高|再得|可得)[^+＋]{0,8}/g, '')
    let safeText = caption + ' ' + safeDetail
    if (DONE_TEXT.test(action)) {
      return { skip: true, reason: '今日已完成' }
    }
    if (/^[0-9]{1,2}点可领$/.test(action)) {
      return { skip: true, reason: '尚未到领取时段' }
    }
    // 摇钱树「点一下施肥/浇水」是轻互动，不是多轮农活
    if (/摇钱树|施肥|浇水/.test(safeText)
        && !/施肥[0-9]+次|浇水[0-9]+次|下单|购买|支付|充值/.test(safeDetail)) {
      return { kind: 'tap', reason: '点一次施肥/浇水' }
    }
    // 答题类需要判断答案，不代做（后端把它交给 answer_quiz，这里保守跳过）
    if (/答题|趣味课堂|问答|考试/.test(safeText)) {
      return { skip: true, reason: '需要答题，跳过' }
    }
    let hard = HARD_RISK_TEXT.exec(safeText)
    if (hard) {
      return { skip: true, reason: '需要手动操作：' + hard[0] }
    }
    // 软风险只有在标题/小字写明了「点击去逛 / 浏览N秒」这类可点描述时才代做
    let soft = SOFT_RISK_TEXT.exec(safeText)
    if (soft && !ACTIONABLE_DETAIL_TEXT.test(safeDetail)) {
      return { skip: true, reason: '需要手动操作：' + soft[0] }
    }
    let seconds = 0
    let duration = /(?:浏览|停留|观看|逛|滑动|下滑)[^0-9]{0,5}([0-9]{1,3})[秒sS]/.exec(safeText)
    if (duration) {
      seconds = parseInt(duration[1])
    }
    if (/小游戏|玩游戏/.test(safeText)) {
      return { kind: 'play', seconds: Math.max(seconds, 10) }
    }
    if (/直播|直播间/.test(safeText)) {
      return { kind: 'watch', seconds: Math.max(seconds, APP_FLOORS['淘宝直播']) }
    }
    let counted = /(?:点击|浏览|逛)[0-9]{1,2}个(?:商品|宝贝)/.exec(safeText)
    if (counted) {
      let countText = /(?:点击|浏览|逛)([0-9]{1,2})个/.exec(safeText)
      return { kind: 'clickProducts', count: countText ? parseInt(countText[1]) : 2 }
    }
    if (/搜一下|搜索|搜一搜|语音搜索/.test(safeText)) {
      return { kind: 'search' }
    }
    let app = _this.targetApp(caption)
    let visitTask = {
      kind: 'visit',
      app: app,
      seconds: Math.max(seconds, APP_FLOORS[app] || OPTIONS.defaultVisitSeconds)
    }
    let claimLike = CLAIM_TEXT.test(action) || /签到/.test(caption)
    // 标题里带应用名、按钮又不是领取/签到的，才是跨应用浏览任务；
    // 「领取天猫红包」这类仍按领取处理
    if (app && !claimLike) {
      return visitTask
    }
    if (claimLike) {
      return { kind: 'claim' }
    }
    if (app) {
      return visitTask
    }
    if (/点击去逛|去逛逛|逛逛|逛一逛|看一看|点一点|去看看|去查看|浏览|观看/.test(safeText)
        || /去完成|去看看|去逛逛|去浏览|去观看|立即看看/.test(action)) {
      return { kind: 'browse', seconds: seconds || OPTIONS.defaultBrowseSeconds }
    }
    return { skip: true, reason: '未识别的任务类型' }
  }

  this.makeRow = function (caption, detail, action, anchorNode, captionNode) {
    let captionText = clean(caption)
    if (captionText.length < 2 || captionText.length > 40) {
      return null
    }
    let classified = _this.classifyTask(captionText, detail || '', action)
    return {
      key: captionText,
      caption: captionText,
      detail: detail || '',
      action: action,
      kind: classified.kind,
      skip: !!classified.skip,
      reason: classified.reason || '',
      seconds: classified.seconds || 0,
      app: classified.app || '',
      count: classified.count || 0,
      anchorNode: anchorNode,
      captionNode: captionNode
    }
  }

  /**
   * 按「右侧动作按钮」和「右侧奖励圈 +N」两种锚点解析任务行
   * （daily.py reward_rows / button_rows 的思路）
   */
  this.parseTasks = function (nodes) {
    nodes = nodes || _this.readNodes()
    let width = config.device_width
    let height = config.device_height
    let rows = []
    let seen = {}

    let addRow = function (row) {
      if (!row) {
        return
      }
      if (seen[row.key]) {
        return
      }
      seen[row.key] = true
      rows.push(row)
    }

    // 1) 右侧动作按钮锚定的行
    let actions = []
    nodes.forEach(function (node) {
      if (node.cy < height * 0.1 || node.y2 > height * 0.99) {
        return
      }
      if (node.y2 - node.y1 >= height * 0.1) {
        return
      }
      if (node.cx < width * 0.5) {
        return
      }
      if (!ACTION_TEXT.test(actionOf(node.text))) {
        return
      }
      actions.push(node)
    })
    actions.sort(function (a, b) {
      return a.cy - b.cy
    })
    let seats = []
    actions.forEach(function (node) {
      if (seats.length === 0 || Math.abs(node.cy - seats[seats.length - 1].cy) > height * 0.03) {
        seats.push(node)
      }
    })
    seats.forEach(function (button) {
      let captionNodes = _this.captionNodes(nodes, button)
      if (captionNodes.length === 0) {
        return
      }
      // 带进度的那行才是标题；OCR 偶尔把两行的 y 读反
      let head = null
      captionNodes.forEach(function (node) {
        if (!head && PROGRESS_TEXT.test(clean(node.text))) {
          head = node
        }
      })
      if (!head) {
        head = captionNodes[0]
      }
      let details = []
      captionNodes.forEach(function (node) {
        if (node !== head) {
          details.push(clean(node.text))
        }
      })
      // 标题和按钮之间的 +N 奖励徽章
      nodes.forEach(function (node) {
        if (!/^[+＋][0-9]+(?:\.[0-9]+)?(?:金币|元)?$/.test(clean(node.text))) {
          return
        }
        if (node.cx < head.cx || node.cx > button.x1) {
          return
        }
        if (Math.abs(node.cy - button.cy) > height * 0.04) {
          return
        }
        details.push(clean(node.text))
      })
      let caption = clean(head.text).replace(PROGRESS_TEXT, '')
      addRow(_this.makeRow(caption, details.join(' '), actionOf(button.text), button, head))
    })

    // 2) 右侧奖励圈（+N / 已领取）锚定的行
    let badges = []
    nodes.forEach(function (node) {
      let text = clean(node.text)
      if (!/^[+＋][0-9]+(?:\.[0-9]+)?(?:金币)?$/.test(text) && !/^(?:已领取|已完成)$/.test(text)) {
        return
      }
      if (node.cx < width * 0.55) {
        return
      }
      if (node.y2 - node.y1 >= height * 0.08) {
        return
      }
      badges.push(node)
    })
    badges.forEach(function (badge) {
      let captionNodes = _this.captionNodes(nodes, badge)
      if (captionNodes.length === 0) {
        return
      }
      let head = captionNodes[0]
      let details = []
      captionNodes.forEach(function (node) {
        if (node !== head) {
          details.push(clean(node.text))
        }
      })
      details.push(clean(badge.text))
      let caption = clean(head.text).replace(PROGRESS_TEXT, '')
      let action = DONE_TEXT.test(actionOf(badge.text)) ? actionOf(badge.text) : '去完成'
      addRow(_this.makeRow(caption, details.join(' '), action, badge, head))
    })
    return rows
  }

  this.productCards = function (nodes) {
    let width = config.device_width
    let height = config.device_height
    let cards = []
    nodes.forEach(function (node) {
      // coins/config.json product_markers
      if (!/[¥￥][0-9]|金币已抵|金币热卖价|点我(?:得|领|拿)?金币/.test(clean(node.text))) {
        return
      }
      if (node.cy < height * 0.08 || node.cy > height * 0.94) {
        return
      }
      if (node.x2 - node.x1 >= width * 0.9) {
        return
      }
      cards.push(node)
    })
    return cards
  }

  this.voiceChips = function (nodes) {
    let height = config.device_height
    let skip = /^搜索$|^取消$|^返回$|^语音$|^语音搜索$|^按住.{0,6}说$|^说点什么$|^历史搜索$|^搜索发现$|^猜你想搜$|^换一换$|^换一批$|^清空$|^关闭$|^[Xx×✕]$/
    let chips = []
    nodes.forEach(function (node) {
      let text = clean(node.text)
      if (text.length < 2 || text.length > 8) {
        return
      }
      if (!chinese(text)) {
        return
      }
      if (skip.test(text) || ACTION_TEXT.test(actionOf(text))) {
        return
      }
      if (node.y2 - node.y1 >= height * 0.06) {
        return
      }
      if (node.cy < height * 0.08 || node.cy > height * 0.85) {
        return
      }
      chips.push(node)
    })
    return chips
  }

  /* ======================== 任务执行 ======================== */

  this.executeClaim = function (row) {
    _this.clickRow(row, '领取 ' + row.caption)
    sleep(1500)
    let nodes = _this.readNodes()
    // 领取后常见的「收下奖励 / 知道了」浮层
    let rewards = _this.matches(nodes, /^(?:收下奖励|开心收下|领取奖励|知道了|我知道了)$/)
    if (rewards.length > 0 && !_this.isTaskPanel(nodes)) {
      _this.clickNode(rewards[0], '奖励弹窗')
      sleep(1200)
      nodes = _this.readNodes()
    }
    if (_this.hasText(nodes, /签到成功|领取成功|奖励已到账|金币已到账|已领取|今日已签到|已签到/)) {
      return true
    }
    if (!_this.isTaskPanel(nodes)) {
      // 领取后跳到别的页面，交给 backToPanel 兜底
      return true
    }
    let after = _this.parseTasks(nodes)
    let same = null
    after.forEach(function (item) {
      if (item.key === row.key) {
        same = item
      }
    })
    if (!same) {
      // 行已经消失（列表刷新出了新的任务）
      return true
    }
    return DONE_TEXT.test(same.action) || same.action !== row.action
  }

  this.executeBrowse = function (row) {
    _this.clickRow(row, '浏览 ' + row.caption)
    sleep(1500)
    _this.handleJumpDialog()
    let nodes = _this.readNodes()
    if (_this.isTaskPanel(nodes)) {
      _this.pushWarningLog('点击后仍停留在任务面板，可能没打开任务页面')
      return false
    }
    let seconds = row.seconds || OPTIONS.defaultBrowseSeconds
    if (!_this.isInTaobao()) {
      // 标题写「浏览」，点开却跳了应用：按跨应用停留下限处理
      seconds = Math.max(seconds, OPTIONS.defaultVisitSeconds)
      _this.stayOnPage(seconds)
      automator.back()
      sleep(1500)
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
      }
      return true
    }
    _this.stayOnPage(seconds + OPTIONS.browseExtraSeconds)
    automator.back()
    sleep(1500)
    return true
  }

  this.isAppInstalled = function (packages) {
    if (!packages || packages.length === 0) {
      return null
    }
    if (_this.installedCache === null) {
      try {
        _this.installedCache = app.getInstalledPackages() || []
      } catch (e) {
        _this.installedCache = []
      }
    }
    if (_this.installedCache.length === 0) {
      // 拿不到安装列表时不做判断，避免把能做的任务全跳过
      return null
    }
    let installed = false
    packages.forEach(function (pkg) {
      if (_this.installedCache.indexOf(pkg) >= 0) {
        installed = true
      }
    })
    return installed
  }

  this.executeVisit = function (row) {
    let packages = APP_PACKAGES[row.app] || []
    if (_this.isAppInstalled(packages) === false) {
      _this.pushLog('未安装' + row.app + '，跳过该任务')
      return false
    }
    _this.clickRow(row, '跳转 ' + row.app)
    sleep(1500)
    _this.handleJumpDialog()
    sleep(1500)
    _this.handleJumpDialog()
    if (_this.isInTaobao()) {
      let nodes = _this.readNodes()
      if (_this.isTaskPanel(nodes)) {
        _this.pushWarningLog('没有离开任务面板，跳转未生效')
        return false
      }
    }
    _this.stayOnPage(row.seconds || OPTIONS.defaultVisitSeconds)
    if (!_this.isInTaobao()) {
      automator.back()
      sleep(1500)
    }
    if (!_this.isInTaobao()) {
      _this.launchTaobao()
      sleep(1500)
    }
    return true
  }

  this.executeWatch = function (row) {
    _this.clickRow(row, '观看直播 ' + row.caption)
    sleep(2000)
    _this.handleJumpDialog()
    if (_this.isInTaobao() && _this.isTaskPanel(_this.readNodes())) {
      _this.pushWarningLog('没有进入直播页面')
      return false
    }
    _this.stayOnPage(row.seconds || OPTIONS.defaultVisitSeconds)
    automator.back()
    sleep(1500)
    // 直播页可能需要多退一层
    let nodes = _this.readNodes()
    if (!_this.isInTaobao()) {
      _this.launchTaobao()
    } else if (_this.hasText(nodes, LIVE_PAGE_TEXT) && !_this.isTaskPanel(nodes)) {
      automator.back()
      sleep(1500)
    }
    return true
  }

  this.executePlay = function (row) {
    _this.clickRow(row, '进入小游戏 ' + row.caption)
    sleep(3000)
    if (_this.isTaskPanel(_this.readNodes())) {
      _this.pushWarningLog('没有进入小游戏页')
      return false
    }
    let play = _this.matches(_this.readNodes(), /^(?:去玩|开始游戏|立即玩|开始挑战|进入游戏)$/)
    if (play.length > 0) {
      _this.clickNode(play[0], '开始游戏')
      sleep(2500)
    }
    _this.stayOnPage(row.seconds || 10)
    automator.back()
    sleep(1500)
    return true
  }

  this.executeTap = function (row) {
    _this.clickRow(row, '打开 ' + row.caption)
    sleep(2500)
    let nodes = _this.readNodes()
    if (_this.isTaskPanel(nodes)) {
      _this.pushWarningLog('没有进入施肥/浇水页面')
      return false
    }
    let tapButton = _this.matches(nodes, /^(?:去|立即|马上|一键|点击|立刻)?(?:施肥|浇水)(?:[0-9]+次)?$/)
    if (tapButton.length > 0) {
      _this.clickNode(tapButton[0], '施肥/浇水')
      sleep(1500)
    } else {
      _this.pushWarningLog('页面上没有找到施肥/浇水按钮')
    }
    automator.back()
    sleep(1500)
    return true
  }

  this.executeSearch = function (row) {
    _this.clickRow(row, '搜索任务 ' + row.caption)
    sleep(1500)
    let nodes = _this.readNodes()
    if (_this.isTaskPanel(nodes)) {
      _this.pushWarningLog('点击后仍停留在任务面板')
      return false
    }
    // 语音搜索页点一个分类就能进结果页，不需要真的说话（daily.py handle_search）
    if (_this.hasText(nodes, /语音搜索|语音得金币|按住.{0,6}说|说点什么/)) {
      let chips = _this.voiceChips(nodes)
      if (chips.length > 0) {
        _this.clickNode(chips[0], '语音搜索分类')
        sleep(2500)
      } else {
        _this.pushWarningLog('语音搜索页没有找到可点的分类')
      }
    } else {
      if (_this.inputKeyword(KEYWORD_TASK)) {
        _this.submitSearch()
        sleep(2500)
      }
    }
    _this.stayOnPage(6)
    automator.back()
    sleep(1500)
    return true
  }

  this.executeClickProducts = function (row) {
    _this.clickRow(row, '商品任务 ' + row.caption)
    sleep(2000)
    if (_this.isTaskPanel(_this.readNodes())) {
      _this.pushWarningLog('没有打开商品页')
      return false
    }
    let need = row.count || 2
    for (let i = 0; i < need && _this.withinBudget(); i++) {
      let cards = _this.productCards(_this.readNodes())
      if (cards.length === 0) {
        _this.shortScroll()
        cards = _this.productCards(_this.readNodes())
      }
      if (cards.length === 0) {
        _this.pushWarningLog('没有找到可点的商品卡片，停止点击')
        break
      }
      _this.clickNode(cards[0], '商品卡片 ' + (i + 1))
      sleep(1500)
      automator.back()
      sleep(1200)
    }
    automator.back()
    sleep(1200)
    return true
  }

  this.executeTask = function (row) {
    if (row.skip) {
      _this.pushLog('跳过任务：' + row.caption + '（' + row.reason + '）')
      return false
    }
    _this.pushLog('执行任务：' + row.caption + ' [' + row.action + '] 类型：' + row.kind)
    if (row.kind === 'claim') {
      return _this.executeClaim(row)
    }
    if (row.kind === 'visit') {
      return _this.executeVisit(row)
    }
    if (row.kind === 'watch') {
      return _this.executeWatch(row)
    }
    if (row.kind === 'play') {
      return _this.executePlay(row)
    }
    if (row.kind === 'tap') {
      return _this.executeTap(row)
    }
    if (row.kind === 'search') {
      return _this.executeSearch(row)
    }
    if (row.kind === 'clickProducts') {
      return _this.executeClickProducts(row)
    }
    return _this.executeBrowse(row)
  }

  /* ======================== 主流程 ======================== */

  /**
   * 任务面板轮次：面板是「做完一个才刷出下一个」，所以每做完一个都要重新读屏；
   * 当前屏确实没有可做的了才往下翻（daily.py run + rescan）
   */
  this.sweep = function () {
    let rounds = 0
    let stall = 0
    let blocked = {}
    while (_this.withinBudget() && rounds < OPTIONS.maxRounds) {
      rounds++
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
      }
      let nodes = _this.readNodes()
      if (!_this.isTaskPanel(nodes)) {
        if (!_this.backToPanel()) {
          _this.pushWarningLog('无法回到淘金币任务面板，结束本轮')
          break
        }
      }
      nodes = _this.readNodes()
      if (!_this.isTaskPanel(nodes)) {
        _this.pushWarningLog('回到页面后仍未识别到任务面板')
        break
      }
      _this.expandPanel(nodes)
      nodes = _this.readNodes()
      let rows = _this.parseTasks(nodes)
      let target = null
      let pending = 0
      rows.forEach(function (row) {
        if (DONE_TEXT.test(row.action)) {
          return
        }
        if (row.skip) {
          pending++
          return
        }
        if ((blocked[row.key] || 0) >= OPTIONS.maxAttemptsPerTask) {
          return
        }
        if (!target) {
          target = row
        }
      })
      if (!target) {
        _this.remainingCount = pending
        // 一个任务行都没解析出来，但页面上确实有动作按钮：至少把签到/领取点掉，
        // 不能因为解析失败就当成“今日已完成”
        if (rows.length === 0) {
          let picked = null
          _this.blindClickButtons(nodes).forEach(function (button) {
            let blindKey = 'blind:' + actionOf(button.text)
            if (!picked && (blocked[blindKey] || 0) < 1) {
              picked = { button: button, key: blindKey, action: actionOf(button.text) }
            }
          })
          if (picked) {
            blocked[picked.key] = (blocked[picked.key] || 0) + 1
            _this.pushLog('任务行解析失败，直接点按钮：' + picked.action)
            _this.clickNode(picked.button, '兜底点击 ' + picked.action)
            sleep(1500)
            _this.handleJumpDialog()
            if (!_this.isTaskPanel(_this.readNodes())) {
              _this.stayOnPage(OPTIONS.defaultBrowseSeconds)
              automator.back()
              sleep(1500)
              _this.progressCount++
              if (/签到/.test(picked.action)) {
                _this.signInDone = true
              }
            }
            if (!_this.isTaskPanel(_this.readNodes()) && !_this.backToPanel()) {
              break
            }
            continue
          }
        }
        if (!_this.scrollPanel()) {
          if (stall >= 2) {
            _this.noMoreTasks = true
            _this.pushLog('面板已经没有可执行任务了')
            break
          }
          stall++
        } else {
          stall = 0
        }
        continue
      }
      let ok = false
      try {
        ok = _this.executeTask(target)
      } catch (e) {
        _this.pushWarningLog('执行任务异常：' + e)
      }
      if (ok) {
        _this.progressCount++
        if (/签到/.test(target.caption)) {
          _this.signInDone = true
        }
        blocked[target.key] = 0
        stall = 0
        _this.pushLog('任务完成：' + target.caption)
      } else if (!target.skip) {
        blocked[target.key] = (blocked[target.key] || 0) + 1
        stall++
        if (stall >= 3) {
          _this.pushWarningLog('连续多次没做成功，结束本轮')
          break
        }
      }
      sleep(1200)
      if (!_this.isTaskPanel(_this.readNodes()) && !_this.backToPanel()) {
        break
      }
    }
  }

  /**
   * 可选步骤：88VIP 每日签到。后端没有这块流程，只做尽力而为，失败不影响主流程。
   */
  this.sign88Vip = function () {
    if (!OPTIONS.enable88Vip) {
      return
    }
    let deadline = new Date().getTime() + 45000
    _this.pushLog('可选步骤：88VIP 每日签到')
    let entry = null
    try {
      entry = widgetUtils.widgetGetOne(/^88VIP$|^88VIP[>〉]?$/, 1500, false, true)
    } catch (e) {
      logUtils.debugInfo(['查找88VIP入口失败：{}', e])
    }
    if (entry) {
      try {
        let bounds = entry.bounds()
        automator.click(Math.round(bounds.centerX()), Math.round(bounds.centerY()))
        _this.pushLog('点击 88VIP 入口')
      } catch (e) {
        _this.pushWarningLog('点击88VIP入口失败：' + e)
      }
    } else {
      let hits = _this.matches(_this.readNodes(), /^88VIP[>〉]?$/)
      if (hits.length === 0) {
        _this.pushLog('首页没有 88VIP 入口，跳过该步骤')
        return
      }
      _this.clickNode(hits[0], '88VIP 入口')
    }
    sleep(2500)
    if (new Date().getTime() > deadline) {
      _this.pushLog('88VIP 步骤超时，跳过')
      return
    }
    let checkin = _this.matches(_this.readNodes(), /^每日签到$|^立即签到$|^签到领积分$|^签到$/)
    if (checkin.length === 0) {
      _this.pushLog('88VIP 页面没有每日签到入口，跳过')
      automator.back()
      sleep(1200)
      return
    }
    _this.clickNode(checkin[0], '88VIP 每日签到')
    sleep(2000)
    if (_this.hasText(_this.readNodes(), /签到成功|已签到|明天再来|明日再来|今日已签到/)) {
      _this.pushLog('88VIP 每日签到完成')
    } else {
      _this.pushLog('88VIP 签到状态未确认')
    }
    automator.back()
    sleep(1200)
    if (!_this.isInTaobao()) {
      automator.back()
      sleep(1200)
    }
  }

  this.exec = function () {
    _this.startTime = new Date().getTime()
    _this.pushLog('开始淘金币日常：入口 → 签到 → 任务面板')
    _this.launchTaobao()
    _this.ensureHomepage()
    _this.sign88Vip()
    _this.ensureHomepage()
    if (!_this.enterCoinPage()) {
      _this.pushErrorLog('未能进入淘金币页面，请检查首页入口是否又改版了')
      _this.logVisibleTexts('当前页面')
      commonFunctions.minimize(PACKAGE_NAME)
      return
    }
    _this.pushLog('已进入淘金币页面，开始处理任务面板')
    _this.sweep()
    // 完成判定：能进面板就说明今天的活动可达；签到成功或面板已无可执行任务才算收工
    let settled = _this.signInDone || _this.noMoreTasks || _this.progressCount > 0
    if (settled) {
      _this.pushLog('淘金币日常完成：领取任务 ' + _this.progressCount + ' 个'
        + (_this.signInDone ? '，签到成功' : '')
        + (_this.remainingCount > 0 ? '，另有 ' + _this.remainingCount + ' 个任务需要手动完成' : ''))
      _this.setExecuted()
    } else {
      _this.pushWarningLog('没有识别到任何可执行任务，保留给下次重试')
    }
    sleep(500)
    commonFunctions.minimize(PACKAGE_NAME)
  }
}

SignRunner.prototype = Object.create(BaseSignRunner.prototype)
SignRunner.prototype.constructor = SignRunner

module.exports = new SignRunner()
