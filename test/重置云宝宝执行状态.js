// 重置云宝宝今天的子任务执行状态
// 用途：主程序（MainExecutor）方式运行时，子任务标记过「今日已执行」后不会再次进入；
//       调试期需要反复跑云宝宝时，先运行本脚本把今天的执行计划重置为待执行。
let { config } = require('../config.js')(runtime, this)
let singletonRequire = require('../lib/SingletonRequirer.js')(runtime, this)
let { logInfo, errorInfo, flushAllLogs } = singletonRequire('LogUtils')
let formatDate = require('../lib/DateUtil.js')
let signTaskService = singletonRequire('SignTaskService')

signTaskService.init()
let date = formatDate(new Date(), 'yyyy-MM-dd')
let list = signTaskService.listSubTaskScheduleByDate(date, 'Yunbaobao')
logInfo('Yunbaobao 今日子任务计划数：' + (list ? list.length : 0))
if (list && list.length > 0) {
  list.forEach(function (schedule) {
    let forUpdate = {
      executeStatus: 'A',
      executeTime: new Date().getTime(),
      realExecuteTime: new Date().getTime(),
      modifyTime: new Date(),
    }
    signTaskService.updateTaskScheduleById(schedule.id, forUpdate)
    logInfo('已重置为待执行：' + schedule.taskCode)
  })
} else {
  logInfo('今日没有 Yunbaobao 子任务计划记录（无需重置）')
}
flushAllLogs()
logInfo('完成，重新运行云宝宝任务即可再次执行全部子任务')
