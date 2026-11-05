/**
 * icons.js —— 线性风格图标库
 *
 * 基础三色（蓝/灰/白，96x96）由 miniprogram/tools/build-icons.js + tools/svg2png.py
 * 生成（脚本在仓库内）；2026-10-16 基调对齐后基色 = #0B6EF8（原 #165DFF 已重渲）。
 * ⚠️ 不要手改 PNG 本体；改色 / 加字形请走 svg2png.py 重渲 + tools/build-icon-colors.py 派生变体。
 *
 * 彩色变体（文件尾「彩色变体」块）由 tools/build-icon-colors.py 按 alpha 通道重着色派生：
 *   python tools/build-icon-colors.py            # 只补缺失
 *   python tools/build-icon-colors.py --force    # 全部重生成
 *   ⚠️ 新增彩色变体后，必须在本文件登记键名，否则 <image src="{{icons.x}}"> 取到 undefined。
 *
 * 说明：微信 <image> 与 tabBar 不支持 SVG，也不支持给 PNG 着色（无 tintColor），
 *       所以「同形状不同颜色」只能预先生成多个 PNG 文件。
 * 用法：<image src="{{icons.home}}" class="ic-md" /> · 深色底用 *Gray / *White / 彩色变体
 */
module.exports = {
  'home': '/assets/icons/home.png',
  'homeGray': '/assets/icons/home_gray.png',
  'chat': '/assets/icons/chat.png',
  'chatGray': '/assets/icons/chat_gray.png',
  'chatWhite': '/assets/icons/chat_white.png',
  'leaf': '/assets/icons/leaf.png',
  'leafWhite': '/assets/icons/leaf_white.png',
  'user': '/assets/icons/user.png',
  'userGray': '/assets/icons/user_gray.png',
  'stethoscope': '/assets/icons/stethoscope.png',
  'stethoscopeWhite': '/assets/icons/stethoscope_white.png',
  'heart': '/assets/icons/heart.png',
  'heartWhite': '/assets/icons/heart_white.png',
  'hospital': '/assets/icons/hospital.png',
  'hospitalWhite': '/assets/icons/hospital_white.png',
  'activity': '/assets/icons/activity.png',
  'pill': '/assets/icons/pill.png',
  'calendar': '/assets/icons/calendar.png',
  'calendarGray': '/assets/icons/calendar_gray.png',
  'tv': '/assets/icons/tv.png',
  'monitor': '/assets/icons/monitor.png',
  'video': '/assets/icons/video.png',
  'videoWhite': '/assets/icons/video_white.png',
  'list': '/assets/icons/list.png',
  'archive': '/assets/icons/archive.png',
  'fileText': '/assets/icons/fileText.png',
  'fileTextWhite': '/assets/icons/fileText_white.png',
  'users': '/assets/icons/users.png',
  'usersGray': '/assets/icons/users_gray.png',
  'bed': '/assets/icons/bed.png',
  'settings': '/assets/icons/settings.png',
  'logout': '/assets/icons/logout.png',
  'info': '/assets/icons/info.png',
  'shield': '/assets/icons/shield.png',
  'refresh': '/assets/icons/refresh.png',
  'refreshGray': '/assets/icons/refresh_gray.png',
  'plus': '/assets/icons/plus.png',
  'plusGray': '/assets/icons/plus_gray.png',
  'search': '/assets/icons/search.png',
  'searchGray': '/assets/icons/search_gray.png',
  'trash': '/assets/icons/trash.png',
  'trashWhite': '/assets/icons/trash_white.png',
  'check': '/assets/icons/check.png',
  'checkWhite': '/assets/icons/check_white.png',
  'checkCircle': '/assets/icons/checkCircle.png',
  'alert': '/assets/icons/alert.png',
  'alertGray': '/assets/icons/alert_gray.png',
  'alertWhite': '/assets/icons/alert_white.png',
  'chevronRight': '/assets/icons/chevronRight.png',
  'chevronRightGray': '/assets/icons/chevronRight_gray.png',
  'chevronLeft': '/assets/icons/chevronLeft.png',
  'mic': '/assets/icons/mic.png',
  'micGray': '/assets/icons/mic_gray.png',
  'micWhite': '/assets/icons/mic_white.png',
  'send': '/assets/icons/send.png',
  'sendWhite': '/assets/icons/send_white.png',
  'share': '/assets/icons/share.png',
  'shareGray': '/assets/icons/share_gray.png',
  'volume': '/assets/icons/volume.png',
  'soundWave': '/assets/icons/soundWave.png',
  'soundWaveGray': '/assets/icons/soundWave_gray.png',
  'clock': '/assets/icons/clock.png',
  'mapPin': '/assets/icons/mapPin.png',
  'mapPinGray': '/assets/icons/mapPin_gray.png',
  'phone': '/assets/icons/phone.png',
  'phoneWhite': '/assets/icons/phone_white.png',
  'star': '/assets/icons/star.png',
  'starGray': '/assets/icons/star_gray.png',
  'moon': '/assets/icons/moon.png',
  'bowl': '/assets/icons/bowl.png',
  'arrowUpRight': '/assets/icons/arrowUpRight.png',
  'bell': '/assets/icons/bell.png',
  'bellGray': '/assets/icons/bell_gray.png',
  'bookOpen': '/assets/icons/bookOpen.png',
  'broom': '/assets/icons/broom.png',
  'clipboardList': '/assets/icons/clipboardList.png',
  'clipboardListGray': '/assets/icons/clipboardList_gray.png',
  'contrast': '/assets/icons/contrast.png',
  'eye': '/assets/icons/eye.png',
  'eyeGray': '/assets/icons/eye_gray.png',
  'fileLock': '/assets/icons/fileLock.png',
  'flask': '/assets/icons/flask.png',
  'globe': '/assets/icons/globe.png',
  'heartbeat': '/assets/icons/heartbeat.png',
  'layoutGrid': '/assets/icons/layoutGrid.png',
  'layoutGridGray': '/assets/icons/layoutGrid_gray.png',
  'lock': '/assets/icons/lock.png',
  'megaphone': '/assets/icons/megaphone.png',
  'personStanding': '/assets/icons/personStanding.png',
  'projector': '/assets/icons/projector.png',
  'sparkles': '/assets/icons/sparkles.png',
  'stop': '/assets/icons/stop.png',
  'textSize': '/assets/icons/textSize.png',
  'thumbDown': '/assets/icons/thumbDown.png',
  'thumbUp': '/assets/icons/thumbUp.png',
  'thumbUpGray': '/assets/icons/thumbUp_gray.png',
  'volumeOff': '/assets/icons/volumeOff.png',
  'wrench': '/assets/icons/wrench.png',
  'zap': '/assets/icons/zap.png',

  /* ==================== 彩色变体（tools/build-icon-colors.py 生成）====================
     用途：页面图标底板（.tile-*）配字、列表行/宫格/统计的**装饰色**字形（参考图即分色系）。
     色板 = 参考图实测「装饰五色」（D-01④，2026-10-16）：#3FAB7C 绿 / #EF5481 粉 /
     #FBA036 橙 / #9566FA 紫（蓝=基色 PNG 本身）；#F53F3F 红保留给语义场景（体检）。
     ⚠️ 只登记**已实际用于页面**的变体；要加新颜色先跑生成脚本再登记。 */
  'archiveMint': '/assets/icons/archive_mint.png',         // 我的·健康档案
  'checkCircleGreen': '/assets/icons/checkCircle_green.png', // 工作台·已完成统计
  'moonPurple': '/assets/icons/moon_purple.png',           // 养生·改善睡眠
  'bowlMint': '/assets/icons/bowl_mint.png',               // 养生·食谱推荐
  'chatMint': '/assets/icons/chat_mint.png',                // 工作台·在线问诊（薄荷底板配绿字形）
  'alertAmber': '/assets/icons/alert_amber.png'             // 适老首页·紧急提示条（橙色警示）
}
