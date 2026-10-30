/**
 * mock-data.js —— 纯前端演示数据源（V3.1 可上线前端版）
 * 说明：本版本为「不考虑后端」的纯前端演示小程序，所有数据集中在此维护，
 * 页面仅读取展示，不伪装任何后端接口。接入真实后端时替换本文件即可。
 */

// 当前登录患者（登录页「我是患者」成功后写入）
const PATIENT = {
  name: '张建国',
  gender: '男',
  age: 65,
  phone: '138****0001',
  idNo: '4401**********1234',
  avatarText: '张'
}

// 首页问候与预约动态
const HOME = {
  greeting: '今天身体有什么不舒服吗？',
  appointment: {
    dept: '呼吸内科',
    doctor: '张主任医师',
    date: '2026-08-30（明天）',
    time: '09:30',
    place: '门诊楼 3 楼 302 诊室',
    status: '已预约'
  }
}

// 导诊知识库：症状关键词 → 科室/建议（纯前端演示映射）
const TRIAGE_RULES = [
  { keywords: ['发热', '发烧', '咳嗽', '咳痰', '流涕', '鼻塞', '嗓子疼', '咽痛'], dept: '呼吸内科', reason: '您描述的症状常见于呼吸系统疾病，建议优先前往呼吸内科。', risk: 'low' },
  { keywords: ['头痛', '头晕', '晕厥', '偏瘫', '口角歪斜', '言语不清'], dept: '神经内科', reason: '头部与神经系统症状，建议前往神经内科进一步检查。', risk: 'medium' },
  { keywords: ['胸闷', '心慌', '心悸', '胸痛', '气短'], dept: '心血管内科', reason: '心脏相关不适需尽快评估，建议前往心血管内科。', risk: 'high' },
  { keywords: ['腹痛', '腹泻', '恶心', '呕吐', '胃痛', '腹胀', '便秘'], dept: '消化内科', reason: '消化系统症状明显，建议前往消化内科就诊。', risk: 'medium' },
  { keywords: ['腰疼', '腰痛', '关节痛', '膝盖', '骨折', '扭伤'], dept: '骨科', reason: '骨骼关节不适建议前往骨科检查。', risk: 'low' }
]

// 科室与医生（挂号页演示数据）
const DEPARTMENTS = [
  { name: '呼吸内科', doctors: [
    { name: '张主任医师', title: '主任医师', expertise: '慢性咳嗽、哮喘、慢阻肺', rating: 4.9 },
    { name: '李副主任医师', title: '副主任医师', expertise: '肺部感染、支气管炎', rating: 4.8 }
  ]},
  { name: '心血管内科', doctors: [
    { name: '王主任医师', title: '主任医师', expertise: '高血压、冠心病', rating: 4.9 }
  ]},
  { name: '消化内科', doctors: [
    { name: '刘副主任医师', title: '副主任医师', expertise: '胃肠疾病、肝病', rating: 4.7 }
  ]},
  { name: '骨科', doctors: [
    { name: '陈主任医师', title: '主任医师', expertise: '关节置换、脊柱疾病', rating: 4.8 }
  ]}
]

// 挂号时段
const TIME_SLOTS = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30']

// 挂号记录（我的 → 挂号记录）
const APPOINTMENTS = [
  { id: 'YY20260828001', dept: '呼吸内科', doctor: '张主任医师', date: '2026-08-30', time: '09:30', place: '门诊楼 3 楼 302 诊室', status: '待就诊', desc: '咳嗽两周，带痰' },
  { id: 'YY20260715002', dept: '心血管内科', doctor: '王主任医师', date: '2026-07-15', time: '10:00', place: '门诊楼 2 楼 205 诊室', status: '已完成', desc: '高血压复查' }
]

// 健康档案（我的 → 健康档案）
const HEALTH_RECORDS = {
  basic: { bloodType: 'A 型', height: '172 cm', weight: '68 kg', allergies: '青霉素过敏', history: '高血压（5 年）' },
  visits: [
    { date: '2026-07-15', dept: '心血管内科', doctor: '王主任医师', diagnosis: '高血压 2 级', prescription: '氨氯地平片 5mg 每日一次' },
    { date: '2026-05-02', dept: '呼吸内科', doctor: '李副主任医师', diagnosis: '急性支气管炎', prescription: '头孢克肟胶囊 0.1g 每日两次' }
  ],
  reports: [
    { date: '2026-07-15', name: '血常规检验报告', org: '检验科', status: '已出报告' },
    { date: '2026-07-15', name: '血压动态监测报告', org: '心血管内科', status: '已出报告' }
  ]
}

// 问诊/咨询记录（我的 → 我的问诊）
const CONSULTATIONS = [
  { id: 'C20260828', type: 'AI 智能问诊', date: '2026-08-28', brief: '咳嗽两周带痰，AI 建议就诊呼吸内科', status: '已完成' },
  { id: 'C20260710', type: '图文咨询', doctor: '刘副主任医师', date: '2026-07-10', brief: '胃胀反酸，医生建议调整饮食并开药', status: '已完成' }
]

// 家庭成员（我的 → 家庭成员管理）
const FAMILY = [
  { id: 1, name: '张建国', relation: '本人', age: 65, gender: '男', phone: '138****0001' },
  { id: 2, name: '李秀英', relation: '配偶', age: 58, gender: '女', phone: '139****0002' },
  { id: 3, name: '张伟', relation: '儿子', age: 38, gender: '男', phone: '137****0003' }
]

// AI 养生（小安：气虚质 + 处暑节气 + 三天方案）
const WELLNESS = {
  constitution: { type: '气虚质', desc: '偏易感冒、乏力', retest: '重新测评' },
  solarTerm: { name: '处暑', tip: '宜润肺健脾、平补防燥' },
  plan: [
    {
      day: '第 1 天（今天）',
      diet: ['早餐：黄芪山药炖瘦肉粥（补气健脾）', '午餐：百合润肺鸭肉汤 + 炒莲藕', '茶饮：太子参麦冬茶（替代日常白开水）'],
      exercise: ['八段锦「调理脾胃须单举」 15 分钟', '最佳练习时间：辰时 (07:00 - 09:00)'],
      sleep: ['按揉足三里、太渊穴各 3 分钟', '睡前艾叶温水泡脚 15 分钟']
    },
    {
      day: '第 2 天（明天）',
      diet: ['早餐：小米南瓜粥 + 蒸山药', '午餐：莲藕排骨汤 + 清炒时蔬', '茶饮：陈皮茯苓茶'],
      exercise: ['太极拳「云手」 10 分钟', '最佳练习时间：巳时 (09:00 - 11:00)'],
      sleep: ['按揉三阴交、气海穴各 2 分钟', '睡前热水泡脚 10 分钟，23:00 前入睡']
    },
    {
      day: '第 3 天',
      diet: ['早餐：红枣桂圆小米粥', '午餐：山药炖鸡汤 + 蒜蓉西兰花', '茶饮：西洋参枸杞茶'],
      exercise: ['散步 30 分钟（微微出汗即可）', '最佳练习时间：下午 16:00 - 17:00'],
      sleep: ['睡前摩腹 100 下，顺时针', '保持规律作息，避免熬夜']
    }
  ]
}

// 智能电视投屏设备列表（演示）
const TV_DEVICES = [
  { name: '客厅小米电视', ip: '192.168.1.102', connected: false },
  { name: '候诊区大屏电视', ip: '192.168.1.108', connected: false }
]

// 电视端大屏预览（叫号屏演示）
const TV_PREVIEW = {
  title: '省二医治管家 · 候诊叫号大屏',
  current: { no: '001 号', name: '张*国', room: '1 号诊室', dept: '呼吸内科' },
  waiting: ['002 号 李*英', '003 号 王*强']
}

// 医生端（深海青工作台演示）
const DOCTOR = {
  account: '13900139001',
  password: 'doc123',
  profile: { name: '王主任', dept: '呼吸科', title: '主任医师' },
  overview: { waiting: 12, inProgress: 1, done: 18 },
  timeline: [
    { time: '09:00', no: '001 号', name: '张建国', gender: '男', age: 65, chief: '咳嗽两周、带痰', status: '就诊中', hasReport: true },
    { time: '09:30', no: '002 号', name: '李秀英', gender: '女', age: 58, chief: '胸闷 1 天', status: '待就诊', hasReport: true },
    { time: '10:00', no: '003 号', name: '王强', gender: '男', age: 42, chief: '过敏性鼻炎复发', status: '待就诊', hasReport: false },
    { time: '10:30', no: '004 号', name: '陈芳', gender: '女', age: 70, chief: '慢阻肺随访', status: '待就诊', hasReport: true }
  ]
}

// 无障碍设置默认值
const SETTINGS = {
  theme: 'standard',      // standard | large | xlarge
  highContrast: false,
  voiceRead: true
}

module.exports = {
  PATIENT,
  HOME,
  TRIAGE_RULES,
  DEPARTMENTS,
  TIME_SLOTS,
  APPOINTMENTS,
  HEALTH_RECORDS,
  CONSULTATIONS,
  FAMILY,
  WELLNESS,
  TV_DEVICES,
  TV_PREVIEW,
  DOCTOR,
  SETTINGS
}
