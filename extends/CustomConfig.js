/*
 * 本地自定义签到任务定义
 *
 * 说明：config.js 里 supported_signs 会 concat 本文件的 supported_signs，
 *      而发布包（GitHub Release）里只有 CustomConfig-demo.js、不含本文件，
 *      所以写在这里的条目在「检测更新/覆盖更新」后不会被冲掉。
 *
 * 新增任务时照着下面的结构加即可，taskCode 需唯一；
 * 脚本名对应 core/ 目录下的文件名。
 */
module.exports = {
  supported_signs: [
    {
      name: '云宝宝看广告',
      taskCode: 'Yunbaobao',
      script: 'Yunbaobao.js',
      enabled: true,
      subTasks: [
        {
          taskCode: 'giftPackage',
          taskName: '惊喜礼包',
          enabled: true
        },
        {
          taskCode: 'dailyCheckIn',
          taskName: '每日打卡',
          enabled: true
        },
        {
          taskCode: 'dailyWatchVideo',
          taskName: '每日看视频10次',
          enabled: true
        },
        {
          taskCode: 'openBox',
          taskName: '开宝箱赚云币',
          enabled: true
        }
      ]
    }
  ]
}
