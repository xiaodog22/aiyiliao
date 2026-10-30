package com.wechar.biz.resource;

import com.wechar.biz.resource.dto.ResourceManifestData;
import com.wechar.biz.resource.dto.ResourceManifestData.Item;
import java.time.Clock;
import java.util.List;
import java.util.Locale;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * GET /api/v1/resources/manifest（契约 operationId getResourceManifest）。
 *
 * 改造（V14）：条目来源从「硬编码 7 条」改为 **resource_asset 表驱动**：
 *  - 只取 `status=1` + 图片 mime + **`delivery='remote'`** 的登记项（V15）；
 *    `delivery='local'` 的资源（219 个图标、默认头像、空态图、导航底图）**不下发 url**，
 *    前端用 `bundle_path` 直接读包内文件 —— 避免"每个图标一次网络往返"的净亏；
 *  - 每项 url = `{app.resources.public-base-url}/api/v1/resources/{key}`；
 *    该配置为空时 url 仍为 null —— 前端行为与改造前完全一致（回退 bundlePath）；
 *  - fallbackKey = 库内 bundle_path（小程序包内路径），远端失败时前端据此回退；
 *  - 表为空（迁移未执行 / 库被清空）→ 回退原内置 7 条，保证清单不空、启动不阻断。
 *
 * 禁令（契约 description + 复核红线，逐条硬校验，命中即 500，不静默过滤）：
 *  - 不下发可执行 JS/WXML（mime 白名单 = 图片，key/url/fallback 不得以可执行后缀结尾）；
 *  - 不下发未签名的安全规则（红旗词表等 token 一律不出现）；
 *  - 不下发 .js/.wxml 等可执行资源。
 */
@Service
public class ResourceManifestService {

    /** 清单语义版本：内容或条目变化必须递增。V14 起条目来自 resource_asset。 */
    static final String MANIFEST_VERSION = "v1.1.0";

    /** 内置资源类型（复核校验维度之一）：仅图片，无 JS/WXML。 */
    private static final String MIME_PNG = "image/png";

    /** 可执行扩展名黑名单（清单红线，逐条拒绝，不靠约定）。 */
    private static final List<String> EXECUTABLE_SUFFIXES =
            List.of(".js", ".wxml", ".wxss", ".json", ".wxs", ".ts", ".mjs", ".cjs", ".jsx", ".html", ".sh");

    /** 未签名安全规则词表标记（红旗词表等，禁止出现在 key/mime/url 任何字段）。 */
    private static final List<String> FORBIDDEN_TOKENS =
            List.of("redflag", "red_flag", "红旗", "flagword", "flag-word", "rule", "规则", "writable");

    private static final List<String> ALLOWED_MIME = List.of(MIME_PNG, "image/webp", "image/jpeg");

    private final Clock clock;
    private final ResourceAssetRepository repository;
    private final String publicBaseUrl;

    public ResourceManifestService(Clock clock,
                                   ResourceAssetRepository repository,
                                   @Value("${app.resources.public-base-url:}") String publicBaseUrl) {
        this.clock = clock;
        this.repository = repository;
        // 归一化：去空白 + 去尾部斜杠，避免拼出 `//api/...`（微信端会当作不同 host path）
        this.publicBaseUrl = publicBaseUrl == null ? "" : publicBaseUrl.trim().replaceAll("/+$", "");
    }

    /**
     * 构造清单。platform（const=wechat-miniprogram）/clientVersion 由控制器校验后传入：
     * 当前无按端差异资源，两参数仅参与清单一致性（clientVersion 超长 → 422 由控制器拦截）。
     */
    public ResourceManifestData manifest(String platform, String clientVersion) {
        List<Item> items = fromDatabase();
        if (items.isEmpty()) {
            items = builtinItems();
        }
        for (Item item : items) {
            enforceRedlines(item);
        }
        return new ResourceManifestData(MANIFEST_VERSION, clock.instant(), items);
    }

    /** 表驱动条目：url 仅在配置了 public-base-url 时下发（绝对 HTTPS）。 */
    private List<Item> fromDatabase() {
        return repository.listActiveImageItems().stream()
                .map(row -> new Item(
                        row.resourceKey(),
                        row.level(),
                        row.mimeType(),
                        row.fileSize() == null ? 0L : row.fileSize(),
                        row.sha256() == null ? "" : row.sha256(),
                        urlFor(row.resourceKey()),
                        MANIFEST_VERSION,
                        null,
                        row.bundlePath()))
                .toList();
    }

    private String urlFor(String key) {
        if (publicBaseUrl.isEmpty()) {
            return null;
        }
        return publicBaseUrl + "/api/v1/resources/" + key;
    }

    /** 空表兜底：与改造前完全一致的内置条目（url 恒 null）。 */
    private static List<Item> builtinItems() {
        return List.of(
                builtin("tab-home", "assets/icons/home.png", 2811, "16369d321b5e582b35e69b412e23e5fc9c920a51a644d0932d1c9dfec9f8e39b"),
                builtin("tab-content", "assets/icons/bookOpen.png", 3287, "a020245eaf3fc55b3fae4adb61b4c86c6e1b8d8b79569580ff2823e534762424"),
                builtin("svc-triage", "assets/home/svc-triage.png", 3269, "7b397297fbfdcd0aa324047840eb6a6c4bdbe1500ea7615a1fcc21b046e0cfcc"),
                builtin("svc-doctor", "assets/home/svc-doctor.png", 3206, "82739fda23d0aca629558395b94db4669467b2fa4cabcf08272b64424ddfea53"),
                builtin("icon-alert", "assets/icons/alert.png", 4239, "3eb58c535f8cfd2c923bbe10ab9bb539156b936e952d141685a44dc75889e4cd"),
                builtin("icon-archive", "assets/icons/archive.png", 1420, "a33e18687df0411be95530cede6188df382f4375c83ae4c2822c550aa9389a37"),
                builtin("icon-activity", "assets/icons/activity.png", 1892, "f25d9872390ee0dcbdcca916c659f94ba49c8e626e0b430dcaa453f05ae1213b"));
    }

    private static Item builtin(String key, String bundlePath, long size, String sha256) {
        // url = null：无远侧分发；fallbackKey 指向同一内置路径（A 级必须声明，清单损坏也可回退）。
        return new Item(key, "A", MIME_PNG, size, sha256,
                null, MANIFEST_VERSION, null, bundlePath);
    }

    /** 逐条硬校验：命中任何一条直接抛 500（清单内容属服务端不变量，不静默过滤）。 */
    private static void enforceRedlines(Item item) {
        String key = item.key() == null ? "" : item.key();
        String mime = item.mime() == null ? "" : item.mime().toLowerCase(Locale.ROOT);
        String url = item.url() == null ? "" : item.url().toLowerCase(Locale.ROOT);
        String fallback = item.fallbackKey() == null ? "" : item.fallbackKey().toLowerCase(Locale.ROOT);

        if (!"A".equals(item.level()) && !"B".equals(item.level())) {
            throw new IllegalStateException("manifest: 非法 level " + item.level());
        }
        if (!ALLOWED_MIME.contains(mime)) {
            throw new IllegalStateException("manifest: 非图片 mime 被拒绝 " + mime);
        }
        for (String suffix : EXECUTABLE_SUFFIXES) {
            if (key.toLowerCase(Locale.ROOT).endsWith(suffix)
                    || url.endsWith(suffix) || fallback.endsWith(suffix)) {
                throw new IllegalStateException("manifest: 拒绝下发可执行资源 " + key);
            }
        }
        String blob = (key + "|" + mime + "|" + url + "|" + fallback).toLowerCase(Locale.ROOT);
        for (String token : FORBIDDEN_TOKENS) {
            if (blob.contains(token.toLowerCase(Locale.ROOT))) {
                throw new IllegalStateException("manifest: 拒绝下发未签名规则类资源 " + key);
            }
        }
        if (item.size() < 0 || item.sha256() == null || item.sha256().length() != 64) {
            throw new IllegalStateException("manifest: 条目完整性校验失败 " + key);
        }
        if (!item.sha256().equals(item.sha256().toLowerCase(Locale.ROOT))) {
            throw new IllegalStateException("manifest: sha256 必须为小写十六进制 " + key);
        }
    }
}
