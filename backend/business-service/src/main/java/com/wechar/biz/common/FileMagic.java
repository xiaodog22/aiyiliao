package com.wechar.biz.common;

import java.io.IOException;
import java.io.InputStream;

/**
 * 上传文件的**内容**嗅探（魔数/文件头），与扩展名白名单配合使用。
 *
 * 为什么需要它（2026-11-12 缺陷 DEF-05）：
 * 扩展名与 Content-Type 都由客户端声明，把 PE 可执行文件改名 a.jpg、声明 image/jpeg
 * 就能被无差别受理。当前靠随机文件名单一性 + 签名 URL 限制了直接危害，但一旦接入
 * 转码/缩略图/PDF 解析，就是可执行攻击面；医疗档案场景下也不合规。
 *
 * 只读前 {@link #HEAD_BYTES} 字节，不做全量解析（不引入图片库依赖，也不给上传路径添 CPU）。
 * 判定失败一律按「格式不支持」拒绝，不尝试猜测真实类型（不落盘、不回显内容）。
 */
public final class FileMagic {

    /** 需要读取的文件头长度：覆盖 mp4 的 'ftyp'（偏移 4~7）与 webp 的 'WEBP'（偏移 8~11）。 */
    public static final int HEAD_BYTES = 12;

    private FileMagic() {
    }

    /** 读取文件头（最多 {@link #HEAD_BYTES} 字节；文件更短时返回实际长度）。 */
    public static byte[] readHead(InputStream in) throws IOException {
        byte[] head = new byte[HEAD_BYTES];
        int read = 0;
        while (read < head.length) {
            int n = in.read(head, read, head.length - read);
            if (n <= 0) {
                break;
            }
            read += n;
        }
        if (read == head.length) {
            return head;
        }
        byte[] actual = new byte[read];
        System.arraycopy(head, 0, actual, 0, read);
        return actual;
    }

    /**
     * 文件头是否与扩展名相符。
     *
     * 签名表：JPEG FF D8 FF / PNG 89 50 4E 47 0D 0A 1A 0A / WEBP "RIFF"+..+"WEBP" /
     * PDF "%PDF" / MP4 偏移 4 起 "ftyp"。未登记扩展名 → false（调用方白名单已先行拦截）。
     */
    public static boolean matches(String ext, byte[] head) {
        if (ext == null || head == null) {
            return false;
        }
        return switch (ext.toLowerCase(java.util.Locale.ROOT)) {
            case "jpg", "jpeg" -> has(head, 0, 0xFF, 0xD8, 0xFF);
            case "png" -> has(head, 0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
            case "webp" -> ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP");
            case "pdf" -> ascii(head, 0, "%PDF");
            case "mp4" -> ascii(head, 4, "ftyp");
            default -> false;
        };
    }

    private static boolean has(byte[] head, int offset, int... expected) {
        if (head.length < offset + expected.length) {
            return false;
        }
        for (int i = 0; i < expected.length; i++) {
            if ((head[offset + i] & 0xFF) != expected[i]) {
                return false;
            }
        }
        return true;
    }

    private static boolean ascii(byte[] head, int offset, String expected) {
        if (head.length < offset + expected.length()) {
            return false;
        }
        for (int i = 0; i < expected.length(); i++) {
            if (head[offset + i] != (byte) expected.charAt(i)) {
                return false;
            }
        }
        return true;
    }
}
