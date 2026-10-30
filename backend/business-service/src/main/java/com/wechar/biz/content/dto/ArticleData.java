package com.wechar.biz.content.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * 契约 Article（N12/N13，additionalProperties:false，required=[id,title,category,type,publishedAt]）。
 * NON_NULL：列表响应省略 sections/tip/related（仅详情下发）；coverUrl=null 时省略（前端不渲染封面）。
 *
 * V19 新增（阶段二）：
 *  - videoUrl：视频签名 URL（TTL 7200s），**仅详情下发**；无 video_key 时为 null → JSON 省略。
 *    列表不拼：列表没有播放器，签名 URL 2 小时内必然过期，塞进列表只会制造无效链接。
 *  - videoDurationSec：表中暂无时长列，恒 null（保留字段位，后续加列即可填充）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ArticleData(
        String id,
        String title,
        String summary,
        String coverUrl,
        String category,
        String type,
        Integer readMin,
        Instant publishedAt,
        List<Section> sections,
        String tip,
        List<String> related,
        String videoUrl,
        Integer videoDurationSec
) {
    /** 分节正文（详情）。 */
    public record Section(String title, String body) {
    }
}
