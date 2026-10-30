package com.wechar.biz.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 微信小程序登录所需的凭证与调用参数（生产档 <b>必需</b>）。
 *
 * <p>配置键（属性 → 环境变量，二者等价，按 Spring 宽松绑定）：</p>
 * <table border="1">
 *   <tr><th>属性</th><th>环境变量</th><th>默认</th></tr>
 *   <tr><td>wechat.miniprogram.app-id</td><td>WECHAT_MINIPROGRAM_APP_ID</td><td>空（未配置）</td></tr>
 *   <tr><td>wechat.miniprogram.app-secret</td><td>WECHAT_MINIPROGRAM_APP_SECRET</td><td>空（未配置）</td></tr>
 *   <tr><td>wechat.miniprogram.api-base-url</td><td>WECHAT_MINIPROGRAM_API_BASE_URL</td><td>https://api.weixin.qq.com</td></tr>
 *   <tr><td>wechat.miniprogram.connect-timeout-ms</td><td>WECHAT_MINIPROGRAM_CONNECT_TIMEOUT_MS</td><td>3000</td></tr>
 *   <tr><td>wechat.miniprogram.read-timeout-ms</td><td>WECHAT_MINIPROGRAM_READ_TIMEOUT_MS</td><td>5000</td></tr>
 * </table>
 *
 * <p><b>红线</b>：AppSecret / AppID 只允许来自运行环境的安全配置（环境变量或受保护的
 * 配置文件），源码、测试夹具、配置样例中<b>一律不得</b>出现真实值。本类刻意
 * 不覆盖 {@code toString()}、不提供任何"打印全部配置"的方法，避免密钥被日志带出。</p>
 */
@Component
@ConfigurationProperties(prefix = "wechat.miniprogram")
public class WechatMiniProgramProperties {

    /** 小程序 AppID（非密钥，但仍按凭证管理，不写死）。 */
    private String appId = "";

    /** 小程序 AppSecret（密钥：绝不入库、绝不入日志、绝不入响应）。 */
    private String appSecret = "";

    /** 微信开放接口基址；仅隔离测试会改为本地受控 mock 服务地址。 */
    private String apiBaseUrl = "https://api.weixin.qq.com";

    /** 建连超时（毫秒）。 */
    private int connectTimeoutMs = 3000;

    /** 单次请求读取超时（毫秒）。 */
    private int readTimeoutMs = 5000;

    public String getAppId() {
        return appId;
    }

    public void setAppId(String appId) {
        this.appId = appId == null ? "" : appId.trim();
    }

    public String getAppSecret() {
        return appSecret;
    }

    public void setAppSecret(String appSecret) {
        this.appSecret = appSecret == null ? "" : appSecret.trim();
    }

    public String getApiBaseUrl() {
        return apiBaseUrl;
    }

    public void setApiBaseUrl(String apiBaseUrl) {
        this.apiBaseUrl = blank(apiBaseUrl) ? "https://api.weixin.qq.com" : apiBaseUrl.trim();
    }

    public int getConnectTimeoutMs() {
        return connectTimeoutMs;
    }

    public void setConnectTimeoutMs(int connectTimeoutMs) {
        this.connectTimeoutMs = connectTimeoutMs;
    }

    public int getReadTimeoutMs() {
        return readTimeoutMs;
    }

    public void setReadTimeoutMs(int readTimeoutMs) {
        this.readTimeoutMs = readTimeoutMs;
    }

    /** 生效的连接超时：非法值（≤0）回退到默认，避免"0 = 无限等待"。 */
    public int effectiveConnectTimeoutMs() {
        return connectTimeoutMs > 0 ? connectTimeoutMs : 3000;
    }

    /** 生效的读取超时：非法值（≤0）回退到默认。 */
    public int effectiveReadTimeoutMs() {
        return readTimeoutMs > 0 ? readTimeoutMs : 5000;
    }

    /** 去掉末尾斜杠的基址（拼路径用）。 */
    public String effectiveApiBaseUrl() {
        String base = blank(apiBaseUrl) ? "https://api.weixin.qq.com" : apiBaseUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base;
    }

    /**
     * 凭证是否齐备。缺失即"依赖未就绪"：调用方必须显式失败（503），
     * <b>不得</b>回退到模拟登录 / 固定用户 / 无鉴权。
     */
    public boolean isConfigured() {
        return !blank(appId) && !blank(appSecret);
    }

    /**
     * 诊断用：只列出缺失的**键名**（不含任何取值），供服务端日志定位部署缺口。
     */
    public String missingKeys() {
        StringBuilder sb = new StringBuilder();
        if (blank(appId)) {
            sb.append("app-id");
        }
        if (blank(appSecret)) {
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append("app-secret");
        }
        return sb.toString();
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
