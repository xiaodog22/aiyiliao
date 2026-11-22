package com.wechar.biz.triage;

import java.util.List;

/**
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * <p>源：shared/triage-redflags.json（急症红旗唯一手写事实源）
 * <br>生成器：tools/gen-triage-flags.js
 * <br>门禁：node tools/gen-triage-flags.js --check（CI frontend job）
 *
 * <p>为什么生成 Java 常量而不是运行时读 JSON：读文件失败会让急症词表为空，
 * 属静默 fail-open；常量类在编译期固化，缺数据直接编译失败。
 *
 * <p>语义（与前端 triage-engine.js matchRedFlags 同构）：
 * any 任一命中；all 非空时还需至少命中一个；none 出现即排除。
 */
public final class RedFlagRules {

    /** 单条急症规则；none 当前为空，保留字段以兼容前端语义。 */
    public record Rule(String id, String label, String advice,
                       List<String> any, List<String> all, List<String> none) {
    }

    public static final List<Rule> ALL = List.of(
            new Rule("chest_pain", "急性胸痛",
                    "胸痛可能是心肌梗死等致命急症，请立即拨打 120，不要自行驾车，原地休息等待救援。",
                    List.of(
                    "胸痛", "胸口痛", "胸口疼", "胸前痛", "胸骨后", "心口痛", "压榨", "胸闷痛", "心前区", "胸口压", "压了块石头", "压着块石头", "石头压"),
                    List.of(
                    "出汗", "冷汗", "大汗", "湿冷", "放射", "左肩", "后背", "下颌", "濒死", "呼吸困难", "喘不上气", "憋", "恶心", "呕吐", "不缓解", "持续", "加重", "心悸", "晕", "脸色苍白", "压榨", "石头"),
                    List.of()),
            new Rule("stroke", "疑似脑卒中",
                    "符合卒中\"FAST\"征象，溶栓有严格时间窗，请立即拨打 120 送往有卒中中心的医院。",
                    List.of(
                    "口角歪斜", "嘴歪", "一侧无力", "半边麻", "偏瘫", "说话不清", "言语不清", "吐字不清", "突然看不清", "视物重影", "一侧肢体无力", "说话含糊", "含糊不清", "半边身子", "半边身没劲", "一侧没劲"),
                    List.of(),
                    List.of()),
            new Rule("dyspnea", "呼吸困难",
                    "呼吸困难属急症，请立即拨打 120，保持坐位、松开衣领，不要平卧。",
                    List.of(
                    "呼吸困难", "喘不上气", "喘不过气", "憋气", "窒息", "吸气困难", "呼吸急促", "喉头水肿", "喘鸣", "憋得慌", "憋得难受", "躺下更喘", "更喘"),
                    List.of(),
                    List.of()),
            new Rule("consciousness", "意识障碍 / 抽搐",
                    "意识障碍或抽搐需立即急救。让患者侧卧防误吸，勿强行按压肢体或喂水，立即拨打 120。",
                    List.of(
                    "昏迷", "意识不清", "叫不醒", "抽搐", "抽风", "惊厥", "晕倒", "昏过去了", "不省人事", "意识模糊", "晕厥", "昏厥", "意识丧失", "人事不省", "不醒人事"),
                    List.of(),
                    List.of()),
            new Rule("bleeding", "活动性大出血",
                    "呕血、咯血、黑便等提示活动性出血，请立即前往急诊，途中保持侧卧、禁食禁水。",
                    List.of(
                    "呕血", "吐血", "咯血", "咳血", "便血", "黑便", "柏油样便", "大出血", "流血不止", "血尿"),
                    List.of(),
                    List.of()),
            new Rule("severe_headache", "剧烈头痛 / 脑膜刺激征",
                    "突发剧烈头痛伴颈项僵硬需警惕蛛网膜下腔出血或脑膜炎，请立即急诊。",
                    List.of(
                    "雷击样头痛", "突然剧烈头痛", "头痛欲裂", "脖子发硬", "颈项强直", "喷射性呕吐", "喷射状"),
                    List.of(),
                    List.of()),
            new Rule("anaphylaxis", "严重过敏反应",
                    "严重过敏可在数分钟内进展为休克，请立即拨打 120；若备有肾上腺素笔请按医嘱使用。",
                    List.of(
                    "全身皮疹", "大片皮疹", "风团", "嘴唇肿", "眼睑肿", "喉头发紧", "过敏性休克"),
                    List.of(
                    "呼吸困难", "胸闷", "头晕", "皮疹", "肿"),
                    List.of()),
            new Rule("poisoning", "中毒 / 中暑 / 溺水 / 电击",
                    "请立即拨打 120，并尽可能带上可疑毒物/药品包装，便于急诊针对性处理。",
                    List.of(
                    "中毒", "误服", "农药", "煤气", "一氧化碳", "中暑", "高热无汗", "溺水", "触电"),
                    List.of(),
                    List.of()),
            new Rule("trauma", "严重外伤",
                    "严重外伤请勿随意搬动伤者，尤其怀疑脊柱损伤时；立即拨打 120 等待专业转运。",
                    List.of(
                    "车祸", "坠落", "摔到头部", "摔伤头部", "开放性骨折", "骨外露", "流血不止", "被撞", "砸伤"),
                    List.of(),
                    List.of()),
            new Rule("acute_abdomen", "急腹症",
                    "腹部板状硬、剧痛提示腹膜炎或脏器穿孔可能，请立即急诊，就诊前禁食禁水、勿服止痛药。",
                    List.of(
                    "板状腹", "肚子硬", "腹部硬", "按下去很疼", "持续剧烈腹痛", "腹痛难忍"),
                    List.of(),
                    List.of()),
            new Rule("infant_fever", "婴幼儿发热",
                    "3 个月以内婴儿发热属高危，请立即前往儿科急诊，不要自行退热观察。",
                    List.of(
                    "发热", "发烧", "高烧"),
                    List.of(
                    "三个月", "3个月", "新生儿", "满月"),
                    List.of()),
            new Rule("pregnancy_emergency", "孕产期急症",
                    "孕产妇出现出血、腹痛、破水或胎动异常，请立即到产科急诊，不要等待门诊。",
                    List.of(
                    "出血", "腹痛", "肚子痛", "破水", "胎动减少", "胎动消失", "规律宫缩"),
                    List.of(
                    "怀孕", "孕妇", "孕期", "产褥", "待产"),
                    List.of()),
            new Rule("self_harm", "自伤 / 自杀风险",
                    "您的安全最重要。请立即联系身边可信任的人陪同，并拨打 120 或全国心理援助热线 12356。",
                    List.of(
                    "自杀", "轻生", "不想活了", "想死", "结束生命"),
                    List.of(),
                    List.of()),
            new Rule("severe_burn", "大面积 / 特殊部位烧伤",
                    "大面积或面部、呼吸道烧伤属急症，请立即拨打 120，切勿涂抹牙膏、酱油等。",
                    List.of(
                    "烧伤", "烫伤", "灼伤"),
                    List.of(
                    "大面积", "面积很大", "脸部", "面部", "呼吸道", "吸入"),
                    List.of()),
            new Rule("high_fever_convulsion", "高热伴抽搐",
                    "发热伴抽搐请立即急诊。发作时让患者侧卧、解开衣领，勿往口中塞任何东西。",
                    List.of(
                    "抽搐", "抽风", "惊厥"),
                    List.of(
                    "发热", "发烧", "高热"),
                    List.of())
    );

    /**
     * 否定语义（B1）：与前端 triage-engine.isNegated 共用 shared 规格。
     *
     * <p>「无/没/没有 + 诱因|原因」修饰的是诱因（无明确诱因的胸痛），
     * 不是否认胸痛；TRIGGER_NOUNS 命中时不得把急症关键词吞掉。
     */
    public static final class Negation {
        public static final int WINDOW = 6;
        public static final int MAX_GAP = 2;
        public static final List<String> WORDS = List.of(
                    "没有", "没", "无", "否认", "不是", "未见", "未出现", "没出现", "不伴", "不伴有", "无伴", "不含");
        public static final List<String> CONTRASTS = List.of(
                    "但", "不过", "却", "而是", "后来", "随后");
        public static final List<String> TRIGGER_NOUNS = List.of(
                    "诱因", "原因");
        /** 弱否定「不」：只认紧邻或隔一个程度词（不舒服3天 不吞 3天）。 */
        public static final String WEAK_TAIL_REGEX = "不[太怎么大很明]{0,2}$";
        /** 弱否定回看跨度：否定字 + 最多程度词数 + 1 个缓冲字。 */
        public static final int WEAK_SPAN = 4;

        private Negation() {
        }
    }

    private RedFlagRules() {
    }
}
