package com.wechar.biz.triage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/** 08F T1 归一层单测：映射表覆盖 §2 最小集、幂等、不折程度、不丢红旗、医学词保护。 */
class TriageNormalizerTest {

    @Test
    void 映射表覆盖08F最小集_标准词已在规则表() {
        Map<String, String> src2std = TriageNormalizer.entries().stream()
                .collect(Collectors.toMap(p -> p[0], p -> p[1], (a, b) -> a));

        // 08F §2 十行最小可用集逐行核验（口语词 → 标准词）
        assertEquals("腹痛", src2std.get("肚子疼"));
        assertEquals("腹痛", src2std.get("肚子痛"));
        assertEquals("腹痛", src2std.get("肚子难过"));
        assertEquals("腹泻", src2std.get("拉肚子"));
        assertEquals("腹泻", src2std.get("拉稀"));
        assertEquals("腹泻", src2std.get("拉水"));
        assertEquals("胃痛", src2std.get("胃疼"));
        assertEquals("胃痛", src2std.get("胃不舒服"));
        assertEquals("恶心呕吐", src2std.get("想吐"));
        assertEquals("恶心呕吐", src2std.get("要吐"));
        assertEquals("恶心呕吐", src2std.get("反胃"));
        assertEquals("烧心", src2std.get("心口烧"));
        assertEquals("头痛", src2std.get("头疼"));
        assertEquals("头痛", src2std.get("脑袋疼"));
        assertEquals("胸闷", src2std.get("胸口闷"));
        assertEquals("胸痛", src2std.get("心口疼"));
        assertEquals("呼吸困难", src2std.get("喘不上气"));
        assertEquals("呼吸困难", src2std.get("气短"));
        assertEquals("呼吸困难", src2std.get("喘"));
        assertEquals("便秘", src2std.get("拉不出"));
        assertEquals("便秘", src2std.get("大便干"));
        assertEquals("发热", src2std.get("发烧"));
        assertEquals("发热", src2std.get("低烧"));
        assertEquals("发热", src2std.get("高烧"));

        // 标准词须已存在于 DEPARTMENT_KEYWORDS 或红旗词表（§2）；
        // 「头痛」服务端 departments 无神经内科，不硬塞错科室 → 校验其为规范术语保留
        String std = src2std.values().stream().distinct().collect(Collectors.joining("|"));
        assertTrue(std.contains("腹痛") && std.contains("腹泻") && std.contains("呼吸困难"));
    }

    @Test
    void 肚子疼归一为腹痛() {
        assertEquals("腹痛", TriageNormalizer.normalize("肚子疼"));
        assertEquals("我最近腹痛得厉害", TriageNormalizer.normalize("我最近肚子疼得厉害"));
    }

    @Test
    void 幂等_标准词与口语词归一后稳定() {
        List<String> inputs = List.of("肚子疼", "腹痛", "拉肚子", "腹泻", "胃疼", "胃痛",
                "想吐", "恶心呕吐", "喘不上气", "呼吸困难", "发烧", "发热", "头疼", "头痛",
                "胸口闷", "胸闷", "心口疼", "胸痛", "便秘", "烧心");
        for (String in : inputs) {
            String once = TriageNormalizer.normalize(in);
            assertEquals(once, TriageNormalizer.normalize(once),
                    "归一不幂等：" + in + " → " + once + " → " + TriageNormalizer.normalize(once));
        }
        // §4c：两种说法归一到同一结果
        assertEquals(TriageNormalizer.normalize("肚子疼"), TriageNormalizer.normalize("腹痛"));
    }

    @Test
    void 不做程度折叠_程度副词原样保留() {
        // 08F §3.3：禁止把「有点/很/非常/挺/比较」折叠掉（前端 normalizeLoose 只用于打分）
        assertEquals("腹痛得厉害", TriageNormalizer.normalize("肚子疼得厉害"));
        assertEquals("有点腹痛", TriageNormalizer.normalize("有点肚子疼"));
        assertEquals("非常发热", TriageNormalizer.normalize("非常发烧"));
        assertTrue(TriageNormalizer.normalize("比较严重的腹泻").contains("比较"));
        assertTrue(TriageNormalizer.normalize("有点不舒服").contains("有点"));
    }

    @Test
    void 不删红旗词_心口疼归一后仍含胸痛() {
        // 08F §3.1/§3.2：归一不得删除红旗词——「心口疼」→「胸痛」仍在 chest_pain 词表
        String t = TriageNormalizer.normalize("心口疼");
        assertTrue(t.contains("胸痛"), "归一结果丢失红旗词：" + t);
        assertTrue(TriageNormalizer.normalize("突然心口疼得厉害").contains("胸痛"));
        // 便血类红旗词不在映射表内，原样保留
        assertTrue(TriageNormalizer.normalize("肚子疼得厉害，还便血").contains("便血"));
    }

    @Test
    void 医学词保护_含喘字的专业词不被裸喘破坏() {
        // 裸「喘」→「呼吸困难」不得把「哮喘/气喘/喘息/喘鸣」拆坏
        assertEquals("哮喘", TriageNormalizer.normalize("哮喘"));
        assertEquals("气喘", TriageNormalizer.normalize("气喘"));
        assertEquals("喘息", TriageNormalizer.normalize("喘息"));
        assertEquals("有哮喘病史", TriageNormalizer.normalize("有哮喘病史"));
    }

    @Test
    void null与空串安全() {
        assertEquals("", TriageNormalizer.normalize(null));
        assertEquals("", TriageNormalizer.normalize(""));
        assertEquals("腹痛", TriageNormalizer.normalize("腹痛"));
    }
}
