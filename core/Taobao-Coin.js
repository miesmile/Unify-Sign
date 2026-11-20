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
// 跳转确认的场景词与允许/拒绝词（daily.py launch_confirmation）：
// 只有画面上出现「启动应用/链接提示/正在离开…」这类场景时才算跳转确认框，
// 否则一律不点，避免把商品页的「打开」或权限弹窗的「允许」当成跳转确认。
const JUMP_SCENE_TEXT = /启动应用|链接提示|打开应用|想要打开|是否打开|即将离开|正在离开|离开.{0,8}打开|跳转提示|外部应用/
const JUMP_ALLOW_TEXT = /^(?:本次允许|允许本次|仅本次|仅打开一次|允许|确认|确认打开|打开|好，继续跳转|继续前往|仍要打开|仍要前往|打开应用)$/
// 「始终允许」这类永久授权不属于一次性跳转，点了会改系统设置，明确排除
const JUMP_DENY_TEXT = /^(?:始终允许|总是允许|不再允许|不再提示|允许所有|授权|同意授权)$/

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
  maxRestarts: 2,                // 单次执行最多强停重启淘宝的次数（daily.py rescan_restart_max）
  maxRescanRestarts: 2,          // 面板「没任务了」之后重启复查的次数（rescan_rounds 缩水版）
  searchBudgetSeconds: 30,       // 搜索提交到确认结果页的时间预算（daily.py page_timeout）
  searchStaySeconds: 8,          // 商品搜索结果页停留时长
  destinationTimeoutSeconds: 6,  // 跨应用跳转后等「页面有内容」的时限
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
/**
 * 当前配置的屏幕尺寸。Automator 内部就是用 config.device_width/device_height
 * 校验点击范围（越界会抛「点击区域超出屏幕外」），所以点击前统一按这两个值对齐。
 */
function screenSpace () {
  let width = Number(config.device_width)
  let height = Number(config.device_height)
  if (!isFinite(width) || width <= 0) {
    width = 1080
  }
  if (!isFinite(height) || height <= 0) {
    height = 1920
  }
  return { width: width, height: height }
}

/**
 * 统一 bounds 成 {x1,y1,x2,y2}
 * 兼容三种来源：Java Rect（left/top/right/bottom）、{left,top,width,height}、数组。
 * 数组按 [x, y, w, h] 解释，但当「宽/高」超出所在图片范围、而它本身又落在范围内的
 * 时候，说明给的其实是右下角坐标 [left, top, right, bottom]，按角点重算。
 *
 * @param {object} bounds 原始 bounds
 * @param {object} space  该坐标所属的画布尺寸（截图尺寸或屏幕尺寸）
 */
function rectOf (bounds, space) {
  if (!bounds) {
    return null
  }
  space = space || screenSpace()
  let x1, y1, x2, y2
  if (typeof bounds.left === 'number' && typeof bounds.top === 'number') {
    if (typeof bounds.right === 'number' && typeof bounds.bottom === 'number') {
      x1 = bounds.left
      y1 = bounds.top
      x2 = bounds.right
      y2 = bounds.bottom
    } else if (typeof bounds.width === 'number' && typeof bounds.height === 'number') {
      x1 = bounds.left
      y1 = bounds.top
      x2 = x1 + bounds.width
      y2 = y1 + bounds.height
    } else {
      return null
    }
  } else if (typeof bounds.length === 'number' && bounds.length >= 4) {
    let a = Number(bounds[0])
    let b = Number(bounds[1])
    let c = Number(bounds[2])
    let d = Number(bounds[3])
    x1 = a
    y1 = b
    x2 = a + c
    y2 = b + d
    let widthLimit = space.width * 1.05
    let heightLimit = space.height * 1.05
    if ((x2 > widthLimit || y2 > heightLimit) && c > a && d > b && c <= widthLimit && d <= heightLimit) {
      x2 = c
      y2 = d
    }
  } else {
    return null
  }
  if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) {
    return null
  }
  if (!(x2 > x1) || !(y2 > y1)) {
    return null
  }
  return { x1: x1, y1: y1, x2: x2, y2: y2 }
}
/** 把文本+bounds 包装成统一的节点对象 */
function nodeOf (text, bounds, space) {
  let rect = rectOf(bounds, space)
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
  this.restartTimes = 0

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

  /**
   * 唯一的坐标点击出口。
   * automator.click 会用 config.device_width/device_height 校验范围，越界直接抛
   * 「点击区域超出屏幕外」；这里先把它规整成屏幕内的整数点，越界时给出越界值
   * 和来源，方便定位是哪一处坐标算错了。
   */
  this.clickPoint = function (x, y, desc) {
    let space = screenSpace()
    let nx = Math.round(Number(x))
    let ny = Math.round(Number(y))
    if (!isFinite(nx) || !isFinite(ny)) {
      _this.pushWarningLog('点击坐标非法（' + (desc || '') + '）：' + x + ',' + y)
      return false
    }
    let outX = nx < 0 || nx >= space.width
    let outY = ny < 0 || ny >= space.height
    if (outX || outY) {
      // 只有擦边（超出不超过屏幕 5%）才夹回屏幕内；差太远说明坐标源算错了，宁可跳过
      let nearX = nx >= -space.width * 0.05 && nx <= space.width * 1.05
      let nearY = ny >= -space.height * 0.05 && ny <= space.height * 1.05
      if (!nearX || !nearY) {
        _this.pushWarningLog('点击坐标超出屏幕，已跳过（' + (desc || '') + '）：' + nx + ',' + ny
          + ' 屏幕 ' + space.width + 'x' + space.height)
        return false
      }
      let cx = Math.min(Math.max(nx, 1), space.width - 2)
      let cy = Math.min(Math.max(ny, 2), space.height - 2)
      logUtils.debugInfo(['越界坐标夹回屏幕内：{},{} -> {},{}', nx, ny, cx, cy])
      nx = cx
      ny = cy
    }
    try {
      automator.click(nx, ny)
      _this.pushLog('点击 ' + (desc || '') + ' (' + nx + ',' + ny + ')')
      sleep(800)
      return true
    } catch (e) {
      _this.pushWarningLog('点击 ' + (desc || '') + ' 失败：' + e)
      return false
    }
  }

  /**
   * 点一个控件（UiObject）。控件可能是列表里滚到屏幕外的那一项，bounds 中心点会
   * 落在屏幕外，所以统一走 clickPoint 校验；坐标不可用时退化成无障碍点击。
   */
  this.clickUiObject = function (widget, desc) {
    if (!widget) {
      _this.pushWarningLog('未找到可点击控件：' + (desc || ''))
      return false
    }
    let bounds = null
    try {
      bounds = widget.bounds()
    } catch (e) {
      bounds = null
    }
    if (bounds) {
      if (_this.clickPoint(bounds.centerX(), bounds.centerY(), desc)) {
        return true
      }
    }
    try {
      if (typeof widget.click === 'function' && widget.click()) {
        _this.pushLog('已通过无障碍点击 ' + (desc || widget.text()))
        sleep(800)
        return true
      }
    } catch (e) {
      _this.pushWarningLog('无障碍点击 ' + (desc || '') + ' 失败：' + e)
    }
    return false
  }

  this.clickNode = function (node, desc) {
    if (!node) {
      _this.pushWarningLog('未找到可点击目标：' + (desc || ''))
      return false
    }
    return _this.clickPoint(node.cx, node.cy, desc || node.text)
  }

  this.clickWidget = function (regex, desc, timeout) {
    let list = []
    try {
      // 全量找：同一段文字常有一份在屏幕外（横向滚动列表、未展示的页面页签），
      // widgetGetOne 会随手返回那颗，中心点自然在屏幕外，点了就报越界
      let found = widgetUtils.widgetGetAll(regex, timeout || 1200, false)
      if (found) {
        if (typeof found.forEach === 'function') {
          found.forEach(function (w) {
            list.push(w)
          })
        } else if (typeof found.size === 'function') {
          for (let i = 0; i < found.size(); i++) {
            list.push(found.get(i))
          }
        }
      }
    } catch (e) {
      logUtils.debugInfo(['控件查找失败：{}', e])
    }
    if (list.length === 0) {
      return false
    }
    let space = screenSpace()
    let visible = 0
    let target = null
    list.forEach(function (w) {
      let bounds = null
      try {
        bounds = w.bounds()
      } catch (e) {
        bounds = null
      }
      if (!bounds) {
        return
      }
      let cx = bounds.centerX()
      let cy = bounds.centerY()
      if (cx < 0 || cy < 0 || cx >= space.width || cy >= space.height) {
        return
      }
      if (bounds.width() <= 0 || bounds.height() <= 0) {
        return
      }
      visible++
      if (!target) {
        target = w
      }
    })
    if (!target) {
      _this.pushWarningLog('「' + (desc || String(regex)) + '」命中 ' + list.length + ' 个控件，但都在屏幕外，已跳过')
      return false
    }
    logUtils.debugInfo(['「{}」命中 {} 个控件，屏幕内 {} 个', desc || String(regex), list.length, visible])
    return _this.clickUiObject(target, desc || String(regex))
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
    // OCR 返回的是「截图坐标」，屏幕点击用的是「config 屏幕坐标」，两者不一定是同一套
    let imgWidth = 0
    let imgHeight = 0
    try {
      imgWidth = screen.getWidth()
      imgHeight = screen.getHeight()
    } catch (e) {
      imgWidth = 0
      imgHeight = 0
    }
    let imgSpace = imgWidth > 0 && imgHeight > 0
      ? { width: imgWidth, height: imgHeight }
      : screenSpace()
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
      let node = nodeOf(item.label, item.bounds, imgSpace)
      if (node) {
        nodes.push(node)
      }
    })
    // 截图分辨率和 config 屏幕尺寸不一致时（折叠屏/分屏/显示缩放），按比例换算回屏幕坐标，
    // 否则点击坐标会整体偏移甚至越界
    let space = screenSpace()
    let sx = imgWidth > 0 ? space.width / imgWidth : 1
    let sy = imgHeight > 0 ? space.height / imgHeight : 1
    if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
      logUtils.debugInfo(['截图 {}x{} 与屏幕 {}x{} 不一致，OCR 坐标按 {} / {} 换算',
        imgWidth, imgHeight, space.width, space.height, sx, sy])
      nodes.forEach(function (node) {
        node.x1 = node.x1 * sx
        node.x2 = node.x2 * sx
        node.cx = node.cx * sx
        node.y1 = node.y1 * sy
        node.y2 = node.y2 * sy
        node.cy = node.cy * sy
      })
    }
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
    if (_this.hasText(nodes, PANEL_MARKERS)) {
      return true
    }
    // 词表兜底：淘宝改版后 list_markers 会整批失效，但「金币」+ 多个动作按钮仍然可靠。
    // 首页也有「淘金币」图标和一两个按钮，所以必须先把首页排除掉。
    if (_this.isHomepage(nodes)) {
      return false
    }
    return _this.hasText(nodes, /金币/) && _this.looksLikeTaskPanel(nodes)
  }

  this.isCoinLanding = function (nodes) {
    return _this.hasText(nodes || _this.readNodes(), LANDING_MARKERS)
  }

  /**
   * 首页判据同 daily.py homepage_visible：底部同时有「我的淘宝」「购物车」
   */
  this.isHomepage = function (nodes) {
    nodes = nodes || _this.readNodes()
    let height = screenSpace().height
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
    let width = screenSpace().width
    let height = screenSpace().height
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
   * 启动/跳转时可能出现「打开 / 仅本次 / 允许」确认窗。
   * daily.py launch_confirmation 的判据：先认场景（启动应用/链接提示/正在离开…），
   * 再在场景内选一次性允许，并明确避开「始终允许」。
   */
  this.handleJumpDialog = function (nodes) {
    nodes = nodes || _this.readNodes()
    if (!_this.hasText(nodes, JUMP_SCENE_TEXT)) {
      return false
    }
    let allow = null
    _this.matches(nodes, JUMP_ALLOW_TEXT).forEach(function (node) {
      if (!allow && !JUMP_DENY_TEXT.test(clean(node.text))) {
        allow = node
      }
    })
    if (allow) {
      return _this.clickNode(allow, '跳转确认 ' + clean(allow.text))
    }
    let widget = null
    try {
      widget = widgetUtils.widgetGetOne(JUMP_ALLOW_TEXT.source, 800)
    } catch (e) {
      logUtils.debugInfo(['查找跳转确认按钮失败：{}', e])
    }
    if (widget) {
      let text = ''
      try {
        text = widget.text() || ''
      } catch (e) {
        text = ''
      }
      if (!JUMP_DENY_TEXT.test(clean(text))) {
        return _this.clickUiObject(widget, '跳转确认 ' + text)
      }
    }
    return false
  }

  /**
   * 轮询等待当前前台应用变成指定包名（刚启动时可能先读到桌面）
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
   * 多种手段把淘宝拉到前台（不做重启），每步校验包名。
   * 不用 app.launchApp（按应用名启动会抛异常把整轮打死），最后一步用 MAIN/LAUNCHER intent。
   */
  this.tryLaunchTaobao = function (purpose) {
    let ptag = purpose ? '（' + purpose + '）' : ''
    let names = ['框架launchPackage', 'app.launch', 'MAIN/LAUNCHER intent']
    let tries = [
      function () {
        commonFunctions.launchPackage(PACKAGE_NAME)
      },
      function () {
        if (typeof app.launch === 'function') {
          app.launch(PACKAGE_NAME)
        }
      },
      function () {
        app.startActivity({
          action: 'android.intent.action.MAIN',
          category: 'android.intent.category.LAUNCHER',
          packageName: PACKAGE_NAME,
          flags: 0x10000000
        })
      }
    ]
    for (let i = 0; i < tries.length; i++) {
      if (!_this.withinBudget()) {
        return false
      }
      try {
        tries[i]()
        _this.pushLog('启动淘宝' + ptag + '：' + names[i])
      } catch (e) {
        _this.pushWarningLog('启动淘宝失败' + ptag + '（' + names[i] + '）：' + e)
        continue
      }
      if (_this.waitCurrentPackage(PACKAGE_NAME, i === 0 ? 3000 : 2500)) {
        sleep(1200)
        _this.handleJumpDialog()
        return _this.isInTaobao()
      }
      _this.pushWarningLog('启动后仍未进入淘宝' + ptag + '（' + names[i] + '）')
    }
    return false
  }

  /**
   * 通过系统「应用信息」页点击「结束运行 / 强行停止」关掉淘宝（无 root 可用）。
   * 流程与 Yunbaobao.forceStopByAppSettings 一致：应用详情页 → 找停止按钮 → 点 → 找确定 → 返回。
   */
  this.forceStopTaobao = function () {
    let backSafely = function () {
      try {
        automator.back()
      } catch (e) {
        // 忽略
      }
    }
    let stopNames = ['强行停止', '结束运行', '强制停止', '停止运行']
    let buttonIds = ['vbutton_title', 'com.android.settings:id/vbutton_title']
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
    let findConfirm = function () {
      // 不要用裸「停止」，否则会命中页面上的「强行停止」按钮本身
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
      _this.pushLog('打开淘宝应用信息页，准备强制停止')
      app.openAppSetting(PACKAGE_NAME)
      sleep(2000)
      let found = null
      let start = new Date().getTime()
      while (!found && new Date().getTime() - start < 6000) {
        found = findStopBtn()
        if (!found) {
          sleep(300)
        }
      }
      if (!found) {
        // 首屏没有就滚动一屏再找（有的机型按钮在页面下方）
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
        _this.pushWarningLog('应用信息页未找到「结束运行/强行停止」按钮')
        _this.logVisibleTexts('应用信息页')
        backSafely()
        return false
      }
      let stopped = false
      for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
        _this.pushLog('点击「' + found.name + '」（第' + (attempt + 1) + '次）')
        _this.clickUiObject(found.node, found.name)
        sleep(900)
        let confirm = findConfirm()
        if (confirm) {
          _this.pushLog('确认弹窗点击「' + (confirm.text() || '确定') + '」')
          _this.clickUiObject(confirm, '停止确认')
          sleep(900)
          // 个别机型确认后还有第二层确认
          let confirm2 = findConfirm()
          if (confirm2) {
            _this.clickUiObject(confirm2, '停止二次确认')
            sleep(800)
          }
          stopped = true
          break
        }
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
          _this.pushLog('「' + again.name + '」已变为不可点击，判定已停止')
          stopped = true
          break
        }
        found = again
        sleep(600)
      }
      if (!stopped) {
        _this.pushWarningLog('多次点击「' + found.name + '」仍未确认停止')
      }
      _this.pushLog('已执行「' + found.name + '」关闭淘宝')
      backSafely()
      sleep(700)
      return true
    } catch (e) {
      _this.pushWarningLog('应用信息页关闭淘宝异常：' + e)
      backSafely()
      return false
    }
  }

  /**
   * 重启淘宝：强制停止进程后重新打开。只在单次执行内做有限次，
   * 避免「失败-重启-再失败」把整轮时间吃光。
   */
  this.restartTaobao = function (purpose) {
    if (_this.restartTimes >= OPTIONS.maxRestarts) {
      _this.pushWarningLog('本次执行已重启淘宝 ' + _this.restartTimes + ' 次，不再重启')
      return _this.isInTaobao()
    }
    _this.restartTimes++
    _this.pushWarningLog('重启淘宝（第 ' + _this.restartTimes + ' 次）：强制停止后重新打开')
    try {
      _this.forceStopTaobao()
      sleep(1200)
      let ok = _this.tryLaunchTaobao(purpose || '重启后')
      if (ok) {
        _this.pushLog('重启淘宝成功')
      } else {
        _this.pushWarningLog('重启淘宝仍失败（当前包：' + _this.currentPackage() + '）')
      }
      return ok
    } catch (e) {
      _this.pushWarningLog('重启淘宝异常：' + e)
      return false
    }
  }

  /**
   * 确保淘宝在前台：先正常拉起，全部手段都失败才重启
   */
  this.launchTaobao = function (purpose) {
    if (_this.tryLaunchTaobao(purpose)) {
      return true
    }
    return _this.restartTaobao(purpose)
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
   * 点完入口后是不是真的进了金币区域：
   * 认得出面板/落地页最好；认不出时，只要「已经不是首页且有金币相关文字」也算进去了，
   * 交给 handleCoinLanding 继续找任务入口或等面板——不要在这里就退回首页。
   */
  this.movedToCoinArea = function (nodes) {
    nodes = nodes || _this.readNodes()
    if (_this.isTaskPanel(nodes) || _this.isCoinLanding(nodes)) {
      return true
    }
    if (_this.isHomepage(nodes)) {
      return false
    }
    return _this.hasText(nodes, /淘金币|金币|赚金币|日常版/)
  }

  /**
   * 首页「领淘金币」入口候选：控件 + OCR 两路，只留屏幕内、避开状态栏与底部栏。
   * 同一段文字在首页常有好几颗（顶栏、频道行、悬浮卡），第一颗不一定真能跳。
   */
  this.coinEntryCandidates = function (nodes) {
    let width = screenSpace().width
    let height = screenSpace().height
    let candidates = []
    let seen = []
    let add = function (key, from, fn) {
      if (seen.indexOf(key) >= 0 || candidates.length >= 6) {
        return
      }
      seen.push(key)
      candidates.push({ from: from, click: fn })
    }
    try {
      let found = widgetUtils.widgetGetAll(/^(?:去|进入|领|领一下)?淘金币[>〉]?$/, 1500, false)
      let list = []
      if (found && typeof found.forEach === 'function') {
        found.forEach(function (widget) {
          list.push(widget)
        })
      }
      list.forEach(function (widget) {
        let cx = 0
        let cy = 0
        try {
          let bounds = widget.bounds()
          cx = bounds.centerX()
          cy = bounds.centerY()
        } catch (e) {
          return
        }
        // 屏幕外的副本（横向图标排里没展示的项）一律不留
        if (cx < 0 || cx >= width || cy < 0 || cy >= height) {
          return
        }
        if (cy < height * 0.08 || cy > height * 0.9) {
          return
        }
        add('w:' + Math.round(cx / 40) + ':' + Math.round(cy / 40),
          '控件(' + Math.round(cx) + ',' + Math.round(cy) + ')',
          function () {
            return _this.clickUiObject(widget, '淘金币入口')
          })
      })
    } catch (e) {
      logUtils.debugInfo(['枚举淘金币入口控件失败：{}', e])
    }
    _this.matches(nodes, /^(?:去|进入|领|领一下)?淘金币[>〉]?$/).forEach(function (node) {
      if (node.cy < height * 0.08 || node.cy > height * 0.9) {
        return
      }
      if (node.cx < width * 0.03 || node.cx > width * 0.97) {
        return
      }
      add('o:' + Math.round(node.cx / 40) + ':' + Math.round(node.cy / 40),
        'OCR(' + Math.round(node.cx) + ',' + Math.round(node.cy) + ')',
        function () {
          return _this.clickNode(node, '淘金币入口')
        })
    })
    return candidates
  }

  /**
   * 点首页频道里的「领淘金币 / 淘金币」入口。
   * 逐个候选点，并用「页面真的离开了首页」来验证，避免对着同一颗不生效的控件反复点。
   */
  this.tapCoinEntry = function (nodes) {
    nodes = nodes || _this.readNodes()
    let candidates = _this.coinEntryCandidates(nodes)
    if (candidates.length === 0) {
      _this.pushLog('首页没有找到淘金币入口')
      return false
    }
    _this.pushLog('首页淘金币入口候选 ' + candidates.length + ' 个')
    let tried = 0
    for (let i = 0; i < candidates.length && tried < 3; i++) {
      tried++
      if (!candidates[i].click()) {
        continue
      }
      sleep(1200)
      let moved = _this.movedToCoinArea(_this.readNodes())
      if (!moved) {
        sleep(900)
        moved = _this.movedToCoinArea(_this.readNodes())
      }
      if (moved) {
        _this.pushLog('淘金币入口已点开（' + candidates[i].from + '）')
        return true
      }
      _this.pushWarningLog('第 ' + tried + ' 个淘金币入口点了没反应（' + candidates[i].from + '），换下一个')
    }
    return false
  }

  /**
   * 搜索页的输入框（search.py search_edit）：优先带焦点的 EditText，
   * 只有一个 EditText 时才认；多个且都没焦点时不猜，免得往隐藏框里写字。
   */
  this.searchEdit = function () {
    try {
      let focused = className('android.widget.EditText').focused(true).findOne(600)
      if (focused) {
        return focused
      }
    } catch (e) {
      logUtils.debugInfo(['查找聚焦输入框失败：{}', e])
    }
    try {
      let list = []
      className('android.widget.EditText').find().forEach(function (view) {
        list.push(view)
      })
      if (list.length === 1) {
        return list[0]
      }
      if (list.length > 1) {
        logUtils.debugInfo(['搜索页有 {} 个输入框且都没有焦点，不猜', list.length])
      }
    } catch (e) {
      logUtils.debugInfo(['枚举输入框失败：{}', e])
    }
    return null
  }

  this.waitSearchEdit = function (timeout) {
    let end = new Date().getTime() + (timeout || 6000)
    while (new Date().getTime() < end) {
      let edit = _this.searchEdit()
      if (edit) {
        return edit
      }
      sleep(500)
    }
    return null
  }

  /**
   * 往搜索框写关键词（search.py fill_search_field + handle_search）：
   * 已经就是目标词就不重复写；写完一定读回来确认，读回不来再用 setText(0, …) 兜底。
   * 这就是「写了淘金币却没确认」的根：原来写完不做校验，键盘一刷新输入框换了个实例。
   */
  this.fillSearchField = function (keyword) {
    if (!_this.isInTaobao()) {
      _this.pushWarningLog('当前不在淘宝，停止输入关键词')
      return false
    }
    let edit = _this.waitSearchEdit(4000)
    if (!edit) {
      _this.pushWarningLog('搜索页没有可确认的输入框，不输入关键词')
      return false
    }
    let target = clean(keyword)
    let current = ''
    try {
      current = clean(edit.text())
    } catch (e) {
      current = ''
    }
    if (current === target) {
      _this.pushLog('输入框已是「' + keyword + '」，不重复输入')
      return true
    }
    for (let i = 0; i < 2; i++) {
      try {
        edit.setText(keyword)
      } catch (e) {
        _this.pushWarningLog('写入关键词失败（第 ' + (i + 1) + ' 次）：' + e)
      }
      sleep(500)
      let after = _this.searchEdit()
      let got = ''
      try {
        got = after ? clean(after.text()) : ''
      } catch (e) {
        got = ''
      }
      if (got && got.indexOf(target) >= 0) {
        _this.pushLog('输入关键词：' + keyword)
        return true
      }
      edit = after || edit
    }
    try {
      setText(0, keyword)
      sleep(600)
      let after = _this.searchEdit()
      if (after && clean(after.text()).indexOf(target) >= 0) {
        _this.pushLog('输入关键词（setText 兜底）：' + keyword)
        return true
      }
    } catch (e) {
      logUtils.debugInfo(['setText 兜底失败：{}', e])
    }
    _this.pushWarningLog('关键词写入后没有读回，按未填写处理')
    return false
  }

  /**
   * 提交按钮只认右上角那个窄的「搜索」（search.py _submit_buttons）：
   * 中心 x > 0.7 屏宽、0 < y < 0.25 屏高、宽度 < 0.3 屏宽
   */
  this.submitButtons = function (nodes) {
    let width = screenSpace().width
    let height = screenSpace().height
    let buttons = []
    ;(nodes || []).forEach(function (node) {
      if (clean(node.text) !== '搜索') {
        return
      }
      if (node.cx < width * 0.7 || node.cy >= height * 0.25) {
        return
      }
      if (node.x2 - node.x1 >= width * 0.3) {
        return
      }
      buttons.push(node)
    })
    buttons.sort(function (a, b) {
      return b.cx - a.cx
    })
    return buttons
  }

  /** 硬件回车提交（AutoJS 无输入法时它不经过 IME 的「搜索」键） */
  this.pressEnter = function () {
    try {
      KeyCode('KEYCODE_ENTER')
      return true
    } catch (e) {
      logUtils.debugInfo(['KeyCode 回车失败：{}', e])
    }
    try {
      shell('input keyevent 66', true)
      return true
    } catch (e2) {
      logUtils.debugInfo(['input keyevent 66 失败：{}', e2])
    }
    return false
  }

  /**
   * 提交搜索并确认结果（search.py handle_search）：
   * 最多点两次搜索按钮，第三次改用回车；每次提交后重新读屏判断结果页，
   * 只有 readyFn 认了才返回 true。原来「点了搜索就 sleep 2.5s 然后开始翻页面」
   * 的写法在按钮被键盘挡住/页面还在动画时会一直卡在搜索页。
   */
  this.submitSearch = function (readyFn, budgetSeconds) {
    let budget = budgetSeconds || OPTIONS.searchBudgetSeconds
    let deadline = new Date().getTime() + budget * 1000
    let submits = 0
    while (new Date().getTime() < deadline && _this.withinBudget()) {
      if (!_this.isInTaobao()) {
        _this.pushWarningLog('搜索过程中已离开淘宝，停止提交')
        return false
      }
      let nodes = _this.readNodes()
      if (readyFn && readyFn(nodes)) {
        return true
      }
      if (submits < 2) {
        let buttons = _this.submitButtons(nodes)
        if (buttons.length > 0) {
          _this.clickNode(buttons[0], '提交搜索（第 ' + (submits + 1) + ' 次）')
        } else {
          _this.pushWarningLog('没有定位到搜索按钮，改用回车提交')
          _this.pressEnter()
        }
        submits++
      } else if (submits === 2) {
        _this.pushLog('两次点按钮仍未确认结果，改用回车提交')
        _this.pressEnter()
        submits++
      }
      sleep(3000)
    }
    let last = _this.readNodes()
    let ok = !!(readyFn && readyFn(last))
    if (!ok) {
      _this.pushWarningLog('搜索提交后仍未确认结果页')
    }
    return ok
  }

  /** 搜索结果里露在首屏的官方淘金币入口（避开商品标题与底部导航） */
  this.coinEntryNodes = function (nodes) {
    let width = screenSpace().width
    let height = screenSpace().height
    let hits = []
    _this.matches(nodes, /^(?:去|进入|领|领一下|打开)?淘金币[>〉]?$/).forEach(function (node) {
      if (node.cy < height * 0.08 || node.cy > height * 0.45) {
        return
      }
      if (node.cx < width * 0.05 || node.cx > width * 0.95) {
        return
      }
      hits.push(node)
    })
    hits.sort(function (a, b) {
      return a.cy - b.cy
    })
    return hits
  }

  /** 商品搜索结果页判据（search.py search_results_ready） */
  this.searchResultsReady = function (nodes) {
    if (!nodes || nodes.length < 6) {
      return false
    }
    if (_this.hasText(nodes, /历史搜索|搜索发现|猜你想搜|搜索推荐/)) {
      // 还挂着搜索历史/推荐 = 仍然停留在搜索页（search.py 的第一条判据）
      return false
    }
    let filters = 0
    ;[/^综合/, /^销量/, /^筛选/, /^店铺/, /^价格/].forEach(function (pattern) {
      if (_this.hasText(nodes, pattern)) {
        filters++
      }
    })
    if (filters >= 2 && nodes.length >= 8) {
      return true
    }
    // 大促的搜索页没有排序工具栏，只有「浏览N秒」横幅 + 商品格
    let height = screenSpace().height
    let banner = _this.hasText(nodes, /浏览[0-9]+[秒sS](?:可领|可得)|浏览完成.*(?:奖励|能量)/)
    let search = _this.matches(nodes, /^搜索$/).some(function (node) {
      return node.cy < height * 0.25
    })
    let products = 0
    nodes.forEach(function (node) {
      if (/[¥￥]\s*[0-9]|金币热卖价|金币已抵/.test(clean(node.text))) {
        products++
      }
    })
    return banner && search && products >= 2
  }

  /**
   * 首页找不到入口时用搜索兜底：搜索「淘金币」→ 确认官方入口出现 → 点进去。
   * 任何一步没确认就不往下走，交给上层换路子（而不是在搜索页里瞎找）。
   */
  this.openCoinBySearch = function () {
    let width = screenSpace().width
    let height = screenSpace().height
    _this.pushLog('首页未找到淘金币入口，改用搜索进入')
    if (!_this.isInTaobao()) {
      _this.pushWarningLog('不在淘宝，无法用搜索进入淘金币')
      return false
    }
    // 1. 打开搜索页：点首页搜索框，然后等「真正的输入框」出现
    let edit = _this.searchEdit()
    if (!edit) {
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
        _this.pushWarningLog('首页没有可点的搜索框')
        return false
      }
      sleep(1200)
      edit = _this.waitSearchEdit(6000)
    }
    if (!edit) {
      _this.pushWarningLog('点了搜索框但没等到输入框，放弃搜索进入')
      return false
    }
    // 2. 写关键词并读回确认
    if (!_this.fillSearchField(KEYWORD_ENTRY)) {
      return false
    }
    // 3. 提交并确认「官方淘金币入口」真的出来了
    let ready = function (list) {
      return _this.coinEntryNodes(list).length > 0 || _this.isCoinLanding(list) || _this.isTaskPanel(list)
    }
    if (!_this.submitSearch(ready, OPTIONS.searchBudgetSeconds)) {
      _this.pushWarningLog('搜索「' + KEYWORD_ENTRY + '」后未确认到淘金币入口')
      return false
    }
    let nodes = _this.readNodes()
    if (_this.isTaskPanel(nodes) || _this.isCoinLanding(nodes)) {
      return true
    }
    let hits = _this.coinEntryNodes(nodes)
    if (hits.length === 0) {
      return false
    }
    _this.clickNode(hits[0], '搜索结果淘金币入口')
    sleep(2000)
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
      if (_this.waitForPanel(4000)) {
        return true
      }
    }
    // 「赚更多金币 / 去赚金币 / 任务中心」：进任务列表（coins/config.json task_entry_labels）
    nodes = _this.readNodes()
    if (_this.isTaskPanel(nodes)) {
      _this.panelReached = true
      return true
    }
    let taskEntry = _this.matches(nodes, /^(?:赚更多金币|去赚金币|赚金币|任务中心|金币任务|每日任务|任务列表|做任务赚金币|做任务)[>〉]?$/)
    if (taskEntry.length > 0) {
      _this.clickNode(taskEntry[0], '进入赚金币任务')
      if (_this.waitForPanel(5000)) {
        return true
      }
    }
    let last = _this.readNodes()
    if (_this.isTaskPanel(last)) {
      _this.panelReached = true
      return true
    }
    // 认不出来就别闷着：把这一页的文本打出来，下次补词表才有依据
    if (!_this.isHomepage(last)) {
      _this.logVisibleTexts('金币页未识别（可能是新版 UI）')
    }
    return false
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
    let searchTried = false
    let entryFailed = false
    for (let i = 0; i < 3 && _this.withinBudget(); i++) {
      let nodes = _this.readNodes()
      if (_this.isTaskPanel(nodes)) {
        _this.panelReached = true
        return true
      }
      _this.dismissPopup(nodes)
      nodes = _this.readNodes()
      if (_this.isHomepage(nodes)) {
        // 首页：先点频道入口（逐个候选验证）；入口这条路试不出结果就立刻改用搜索
        if (!entryFailed) {
          if (_this.tapCoinEntry(nodes)) {
            _this.handleJumpDialog()
            if (_this.handleCoinLanding()) {
              return true
            }
            _this.pushWarningLog('入口点开了但没落到任务面板，改用搜索兜底')
          } else {
            _this.pushWarningLog('首页入口点不开，改用搜索兜底')
          }
          entryFailed = true
        }
        if (!searchTried) {
          searchTried = true
          if (_this.openCoinBySearch()) {
            _this.handleJumpDialog()
            if (_this.handleCoinLanding()) {
              return true
            }
          }
        }
      } else {
        // 已经不在首页：先当金币页处理（认不出的页面也要把文本记下来）
        if (_this.handleCoinLanding(nodes)) {
          return true
        }
      }
      // 退一层，下一轮重新判定（下一轮多半回到首页，还能再走一次入口/搜索）
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
        continue
      }
      _this.pushLog('第 ' + (i + 1) + ' 轮没进到任务面板，退一层重试')
      automator.back()
      sleep(1500)
    }
    return _this.isTaskPanel(_this.readNodes())
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
    nodes = nodes || _this.readNodes()
    if (!_this.isTaskPanel(nodes)) {
      return false
    }
    let before = _this.parseTasks(nodes).length
    // daily.py ensure_expanded：点一次不算数，要等任务真的画出来；没画出来再点一次
    for (let attempt = 0; attempt < 2; attempt++) {
      if (_this.expandTimes >= OPTIONS.maxExpandTimes) {
        return false
      }
      let expand = _this.matches(nodes, /^展开[⌄⌃^＞>〉·.]*$/)
      if (expand.length === 0) {
        // 按钮已经不在：要么已经展开（变成「收起」），要么这一版没有展开
        return false
      }
      _this.expandTimes++
      _this.pushLog('展开全部任务（第 ' + _this.expandTimes + ' 次）')
      _this.clickNode(expand[0], '展开任务列表')
      sleep(1800)
      nodes = _this.readNodes()
      if (_this.parseTasks(nodes).length > before) {
        return true
      }
      if (!_this.isTaskPanel(nodes)) {
        return true
      }
    }
    return true
  }

  this.findCloseNode = function (nodes) {
    let height = screenSpace().height
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
    let width = screenSpace().width
    let height = screenSpace().height
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
   * 把面板滚回顶部（daily.py reset_list_scroll）：
   * 上一轮滑到底之后，首屏的任务行会被滚出视野，下次进来会漏掉它们。
   */
  this.resetPanelScroll = function () {
    let width = screenSpace().width
    let height = screenSpace().height
    let x = Math.round(width * 0.5)
    for (let i = 0; i < 4; i++) {
      try {
        automator.swipe(x, Math.round(height * 0.35), x, Math.round(height * 0.8), 400)
      } catch (e) {
        logUtils.debugInfo(['回滚面板失败：{}', e])
        return
      }
      sleep(500)
    }
    _this.pushLog('任务面板已滚回顶部')
  }

  /**
   * 在面板里往下找更多任务。滑完已经不是面板了（浮层被关掉）就返回 false，
   * 交给上层重新进页面。
   */
  this.scrollPanel = function () {
    let beforeSig = _this.panelSignature(_this.readNodes())
    let width = screenSpace().width
    let height = screenSpace().height
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
    let width = screenSpace().width
    let height = screenSpace().height
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
    let width = screenSpace().width
    let height = screenSpace().height
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
    let width = screenSpace().width
    let height = screenSpace().height
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
    let height = screenSpace().height
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

  /**
   * 跳到目标应用后确认「页面真的有内容」（daily.py destination_ready）：
   * 只认 10%~97% 高度上、≥2 个中文文本节点，状态栏/空白不算到货。
   * 还在淘宝就顺手把冒出来的跳转确认框处理掉（最多两次确认）。
   */
  this.waitDestination = function (timeout) {
    let height = screenSpace().height
    let end = new Date().getTime() + (timeout || OPTIONS.destinationTimeoutSeconds) * 1000
    while (new Date().getTime() < end) {
      if (_this.isInTaobao()) {
        if (_this.handleJumpDialog(_this.readNodes())) {
          sleep(1200)
          continue
        }
        sleep(600)
        continue
      }
      let nodes = _this.readNodes()
      let content = 0
      nodes.forEach(function (node) {
        let text = clean(node.text)
        if (text.length < 2 || !chinese(text)) {
          return
        }
        if (node.cy < height * 0.1 || node.cy > height * 0.97) {
          return
        }
        content++
      })
      if (content >= 2) {
        return true
      }
      sleep(800)
    }
    return false
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
    if (_this.isInTaobao() && _this.isTaskPanel(_this.readNodes())) {
      // daily.py：两次确认仍未离开面板就算这个任务这次做不了，只跳过它自己
      _this.handleJumpDialog()
      if (_this.isTaskPanel(_this.readNodes())) {
        _this.pushWarningLog('两次确认后仍停留在任务面板，跳转未生效，本次跳过该任务')
        return false
      }
    }
    if (!_this.waitDestination()) {
      _this.pushWarningLog('目标应用 ' + (row.app || '') + ' 没有加载出页面内容，本次跳过该任务')
      if (!_this.isInTaobao()) {
        automator.back()
        sleep(1500)
      }
      if (!_this.isInTaobao()) {
        _this.launchTaobao()
      }
      return false
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
    let confirmed = false
    let resultsReady = function (list) {
      return _this.searchResultsReady(list)
    }
    // 语音搜索页点一个分类就能进结果页，不需要真的说话（daily.py handle_search）
    if (_this.hasText(nodes, /语音搜索|语音得金币|按住.{0,6}说|说点什么/)) {
      let chips = _this.voiceChips(nodes)
      if (chips.length > 0) {
        _this.clickNode(chips[0], '语音搜索分类')
        sleep(2500)
        confirmed = resultsReady(_this.readNodes())
      } else {
        _this.pushWarningLog('语音搜索页没有找到可点的分类')
      }
      if (!confirmed) {
        if (_this.fillSearchField(KEYWORD_TASK)) {
          confirmed = _this.submitSearch(resultsReady, OPTIONS.searchBudgetSeconds)
        }
      }
    } else {
      if (_this.fillSearchField(KEYWORD_TASK)) {
        confirmed = _this.submitSearch(resultsReady, OPTIONS.searchBudgetSeconds)
      }
      if (!confirmed) {
        _this.pushWarningLog('搜索任务未确认进入商品结果页')
      }
    }
    if (confirmed) {
      _this.stayOnPage(OPTIONS.searchStaySeconds)
    }
    automator.back()
    sleep(1500)
    return confirmed
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
    _this.expandTimes = 0
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
            _this.resetPanelScroll()
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
    let clicked = _this.clickWidget(/^88VIP$|^88VIP[>〉]?$/, '88VIP 入口', 1500)
    if (!clicked) {
      let hits = _this.matches(_this.readNodes(), /^88VIP[>〉]?$/)
      if (hits.length === 0) {
        _this.pushLog('首页没有 88VIP 入口，跳过该步骤')
        return
      }
      clicked = _this.clickNode(hits[0], '88VIP 入口')
    }
    if (!clicked) {
      _this.pushLog('88VIP 入口点不到，跳过该步骤')
      return
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

  /**
   * 屏幕口径对账 + 校准。
   * 三个口径：config.device_width/height（Automator 用它校验越界）、device.width/height、
   * 截图/控件 bounds 的真实像素。其中「截图 + 控件 bounds」才是点击真正生效的空间，
   * 后两者比 config 大时（显示缩放、分辨率设置、折叠屏展开），合法坐标也会被判定越界。
   */
  this.measureScreenSpace = function () {
    let space = screenSpace()
    let deviceWidth = 0
    let deviceHeight = 0
    try {
      deviceWidth = Number(device.width)
      deviceHeight = Number(device.height)
    } catch (e) {
      deviceWidth = 0
      deviceHeight = 0
    }
    let imgWidth = 0
    let imgHeight = 0
    try {
      let screen = commonFunctions.captureScreen()
      if (screen) {
        imgWidth = Number(screen.getWidth())
        imgHeight = Number(screen.getHeight())
      }
    } catch (e) {
      imgWidth = 0
      imgHeight = 0
    }
    let nodes = _this.uiNodes()
    let maxX = 0
    let maxY = 0
    nodes.forEach(function (node) {
      if (node.x2 > maxX) {
        maxX = node.x2
      }
      if (node.y2 > maxY) {
        maxY = node.y2
      }
    })
    logUtils.debugInfo(['屏幕口径：config {}x{} device {}x{} 截图 {}x{} 控件最大 {}x{}（控件 {} 个）',
      space.width, space.height, deviceWidth, deviceHeight,
      imgWidth, imgHeight, Math.round(maxX), Math.round(maxY), nodes.length])
    // 截图比 config 大：config 不是真实像素口径，按截图校准，否则合法坐标会被误判越界
    if (imgWidth > 2 && imgHeight > 2
      && (imgWidth - space.width > 2 || imgHeight - space.height > 2)) {
      let originWidth = space.width
      let originHeight = space.height
      config.device_width = imgWidth
      config.device_height = imgHeight
      let applied = false
      try {
        applied = typeof automator.checkClickable === 'function'
          ? automator.checkClickable(imgWidth - 1, imgHeight - 1)
          : true
      } catch (e) {
        applied = false
      }
      if (applied) {
        _this.pushWarningLog('config 屏幕尺寸 ' + originWidth + 'x' + originHeight
          + ' 与截图 ' + imgWidth + 'x' + imgHeight + ' 不一致，已按截图校准点击范围')
      } else {
        config.device_width = originWidth
        config.device_height = originHeight
        _this.pushWarningLog('config 屏幕尺寸 ' + originWidth + 'x' + originHeight
          + ' 与截图 ' + imgWidth + 'x' + imgHeight + ' 不一致，且 Automator 未共用配置，'
          + '超出 ' + originWidth + 'x' + originHeight + ' 的控件一律跳过')
      }
    }
    return screenSpace()
  }

  /** 当前页面开头几个中文文本，用来在日志里说明「停在了哪个页面」 */
  this.currentPageHint = function (nodes) {
    let texts = []
    ;(nodes || []).forEach(function (node) {
      let text = clean(node.text)
      if (text && chinese(text) && texts.indexOf(text) < 0 && texts.length < 3) {
        texts.push(text)
      }
    })
    return texts.join('/') || '未知页面'
  }

  /**
   * 开始前的启动策略（按页面状态判断，不做无条件强停）：
   * - 不在淘宝前台：直接拉起，不强停（省 10~20 秒）
   * - 已在首页或淘金币面板：直接沿用，不重启
   * - 在淘宝但停在别的内页（商品页/88VIP页/搜索页/活动页）：强停重开，回到干净的首页
   */
  this.prepareTaobao = function () {
    if (!_this.isInTaobao()) {
      _this.pushLog('当前不在淘宝前台，直接打开淘宝（不强停）')
      if (_this.tryLaunchTaobao('开始前')) {
        return true
      }
      return _this.restartTaobao('开始前（直接拉起失败）')
    }
    let nodes = _this.readNodes()
    if (_this.isTaskPanel(nodes)) {
      _this.pushLog('淘宝已在前台且停在淘金币面板，跳过重启')
      _this.handleJumpDialog(nodes)
      return true
    }
    if (_this.isHomepage(nodes)) {
      _this.pushLog('淘宝已在前台且停在首页，跳过重启')
      _this.handleJumpDialog(nodes)
      return true
    }
    _this.pushLog('淘宝已在前台但停在非首页（' + _this.currentPageHint(nodes) + '），强停重启回首页')
    return _this.restartTaobao('开始前')
  }

  this.exec = function () {
    _this.startTime = new Date().getTime()
    // 每次 run 重置重启预算（daily.py 的 _rescan_restarts 也是按 run 清零）
    _this.restartTimes = 0
    _this.progressCount = 0
    _this.noMoreTasks = false
    _this.measureScreenSpace()
    _this.pushLog('开始淘金币日常：入口 → 签到 → 任务面板')
    // 淘宝停在残留内页时才强停重开，避免把上次的商品页/活动页直接拉回前台
    if (!_this.prepareTaobao()) {
      _this.pushErrorLog('启动淘宝失败，结束本次执行')
      _this.logVisibleTexts('当前页面')
      commonFunctions.minimize(PACKAGE_NAME)
      return
    }
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
    // 补扫：面板说「没任务了」时，重启一次客户端再进面板复查——
    // WebView 缓存不刷新会漏掉刚刷出来的任务（daily.py rescan + rescan_restart_app）
    let rescans = 0
    while (_this.noMoreTasks && rescans < OPTIONS.maxRescanRestarts && _this.withinBudget()
      && _this.restartTimes < OPTIONS.maxRestarts) {
      rescans++
      _this.pushLog('第 ' + rescans + ' 次重启复查：确认面板是不是真的没有任务了')
      _this.noMoreTasks = false
      if (!_this.restartTaobao('补扫')) {
        _this.pushWarningLog('补扫重启失败，结束复查')
        break
      }
      _this.ensureHomepage()
      if (!_this.enterCoinPage()) {
        _this.pushWarningLog('补扫时未能重新进入淘金币面板')
        break
      }
      let before = _this.progressCount
      _this.sweep()
      if (_this.progressCount === before) {
        _this.pushLog('复查后仍没有新任务，确认收工')
        _this.noMoreTasks = true
        break
      }
    }
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
