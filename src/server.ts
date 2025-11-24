import { FastMCP } from "fastmcp";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const server = new FastMCP({
    name: 'demo-server',
    version: '1.0.0'
});

// KataGo を起動し、sgf/test.sgf を play コマンドで再現して終了するツール
// index.ts の内容を MCP ツールとして移植（プロセス終了や readline は使用しない）
type ParsedMove = { color: "b" | "w"; sgf: string };
type ParsedSgf = {
    size: number;
    komi: number;
    ab: string[];
    aw: string[];
    moves: ParsedMove[];
    pb?: string; // Black player
    pw?: string; // White player
    re?: string; // Result
    ha?: number; // Handicap stones count
};

function parseSgfFromText(sgfText: string): ParsedSgf {
    function parseRootNumber(tag: string, fallback: number): number {
        const m = sgfText.match(new RegExp(`${tag}\\[([^\\]]*)\\]`, "i"));
        if (!m) return fallback;
        const v = Number(m[1]);
        return Number.isFinite(v) ? v : fallback;
    }
    function parseRootString(tag: string): string | undefined {
        const m = sgfText.match(new RegExp(`${tag}\\[([^\\]]*)\\]`, "i"));
        if (!m) return undefined;
        return (m[1] ?? "").trim();
    }
    function parseRootList(tag: string): string[] {
        const tagPos = sgfText.search(new RegExp(`${tag}\\[`, "i"));
        if (tagPos < 0) return [];
        const slice = sgfText.slice(tagPos);
        const items: string[] = [];
        // SGF の [ ... ] を抽出する正規表現（リテラルの [ と ] は 1 つのバックスラッシュでエスケープ）
        const bracketRe = /\[([^\]]*)\]/g;
        let m: RegExpExecArray | null;
        while ((m = bracketRe.exec(slice)) !== null) {
            items.push(m[1] || "");
        }
        return items;
    }
    function parseMoves(): ParsedMove[] {
        const moves: ParsedMove[] = [];
        // 手の表現 ";B[aa]" / ";W[bb]" を抽出
        const re = /;([BW])\[([^\]]*)\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sgfText)) !== null) {
            const color = m[1] === "B" ? "b" : "w";
            const coord = m[2] || "";
            moves.push({ color, sgf: coord });
        }
        return moves;
    }
    return {
        size: parseRootNumber("SZ", 19),
        komi: parseRootNumber("KM", 6.5),
        ab: parseRootList("AB"),
        aw: parseRootList("AW"),
        moves: parseMoves(),
        pb: parseRootString("PB"),
        pw: parseRootString("PW"),
        re: parseRootString("RE"),
        ha: (() => {
            const m = sgfText.match(/HA\[([^\]]*)\]/i);
            if (!m) return undefined;
            const v = Number(m[1]);
            return Number.isFinite(v) ? v : undefined;
        })(),
    };
}

function sgfToGtpCoord(sgfPoint: string, size: number): string {
    if (!sgfPoint || sgfPoint.length !== 2) return "pass";
    const ax = sgfPoint.charCodeAt(0) - 97;
    const ay = sgfPoint.charCodeAt(1) - 97;
    if (ax < 0 || ay < 0 || ax >= size || ay >= size) return "pass";
    const colIdx = ax;
    const rowFromBottom = size - ay;
    let colCode = "A".charCodeAt(0) + colIdx;
    if (colCode >= "I".charCodeAt(0)) colCode += 1; // I 列をスキップ
    const col = String.fromCharCode(colCode);
    return `${col}${rowFromBottom}`;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`環境変数 ${name} が設定されていません (.env を確認してください)`);
    }
    return value;
}

// ===== 盤面画像生成ユーティリティ（SVG） =====
type Stone = { x: number; y: number; color: "b" | "w" };

function sgfToPoint(sgfPoint: string, size: number): { x: number; y: number } | null {
    if (!sgfPoint || sgfPoint.length !== 2) return null;
    const ax = sgfPoint.charCodeAt(0) - 97; // 'a' -> 0
    const ay = sgfPoint.charCodeAt(1) - 97;
    if (ax < 0 || ay < 0 || ax >= size || ay >= size) return null;
    // SGF は左上原点。SVG でも左上原点で描画するため変換不要
    return { x: ax, y: ay };
}

function buildPosition(parsed: ParsedSgf, uptoMove: number): { stones: Stone[]; last?: Stone } {
    const stones: Stone[] = [];
    const size = parsed.size;

    // 置き石
    for (const p of parsed.ab) {
        const pt = sgfToPoint(p, size);
        if (pt) stones.push({ ...pt, color: "b" });
    }
    for (const p of parsed.aw) {
        const pt = sgfToPoint(p, size);
        if (pt) stones.push({ ...pt, color: "w" });
    }

    const n = Math.max(0, Math.min(uptoMove -1, parsed.moves.length));
    for (let i = 0; i < n; i++) {
        const mv = parsed.moves[i];
        const pt = sgfToPoint(mv.sgf, size);
        if (!pt) continue; // pass 等はスキップ
        stones.push({ ...pt, color: mv.color });
    }

    const last = stones.length > 0 ? stones[stones.length - 1] : undefined;
    return { stones, last };
}

type VariationOverlay = { moves: { x: number; y: number; color: "b" | "w"; label: number }[]; alpha?: number };

function renderBoardSVG(
    size: number,
    stones: Stone[],
    opts?: { cell?: number; margin?: number; last?: Stone; rightPanel?: { lines: string[]; width?: number; gap?: number; title?: string }, variationOverlay?: VariationOverlay }
): string {
    const cell = opts?.cell ?? 40;
    const margin = opts?.margin ?? 30;
    const boardPx = margin * 2 + cell * (size - 1);
    const rp = opts?.rightPanel;
    const gapPx = rp ? (rp.gap ?? 20) : 0;
    // 右パネル幅: 指定があれば優先。未指定時はテキスト量に応じて動的に決定し、見切れを防ぐ。
    // 推定1文字幅などは後段のタイポグラフィ設定と一致させる。
    let panelWidth = 0;
    if (rp) {
        if (rp.width && rp.width > 0) {
            panelWidth = rp.width;
        } else {
            // 後で実際のフォントサイズ確定後に再計算するため、暫定値を置く
            panelWidth = Math.max(360, Math.floor(cell * 10));
        }
    }
    // totalWidth は後で確定。高さは右パネルの内容量に応じて可変にする

    const parts: string[] = [];
    const strokeGrid = "#333";
    const strokeWidth = 2;
    const boardFill = "#DEB887";

    parts.push(`<rect x="0" y="0" width="${boardPx}" height="${boardPx}" fill="${boardFill}" />`);

    // 筋
    for (let i = 0; i < size; i++) {
        const x = margin + i * cell;
        const y0 = margin;
        const y1 = margin + cell * (size - 1);
        parts.push(`<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="${strokeGrid}" stroke-width="${strokeWidth}" />`);

        const y = margin + i * cell;
        const x0 = margin;
        const x1b = margin + cell * (size - 1);
        parts.push(`<line x1="${x0}" y1="${y}" x2="${x1b}" y2="${y}" stroke="${strokeGrid}" stroke-width="${strokeWidth}" />`);
    }

    // 星
    const hoshi = ((): { x: number; y: number }[] => {
        if (size === 19) {
            const pts = [3, 9, 15];
            const r: { x: number; y: number }[] = [];
            for (const i of pts) for (const j of pts) r.push({ x: i, y: j });
            return r;
        } else if (size === 13) {
            const pts = [3, 6, 9];
            const r: { x: number; y: number }[] = [];
            for (const i of pts) for (const j of pts) r.push({ x: i, y: j });
            return r;
        } else if (size === 9) {
            const pts = [2, 4, 6];
            const r: { x: number; y: number }[] = [];
            for (const i of pts) for (const j of pts) r.push({ x: i, y: j });
            return r;
        }
        return [];
    })();

    for (const p of hoshi) {
        const cx = margin + p.x * cell;
        const cy = margin + p.y * cell;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="#333" />`);
    }

    // 石
    for (const s of stones) {
        const cx = margin + s.x * cell;
        const cy = margin + s.y * cell;
        const r = cell * 0.45;
        if (s.color === "b") {
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000" stroke="#111" stroke-width="2" />`);
        } else {
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#aaa" stroke-width="2" />`);
            parts.push(`<circle cx="${cx - r/3}" cy="${cy - r/3}" r="${r/4}" fill="#fff" opacity="0.7" />`);
        }
    }

    // 直前手マーク
    const last = opts?.last;
    if (last) {
        const cx = margin + last.x * cell;
        const cy = margin + last.y * cell;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${cell * 0.15}" fill="#ff3b30" stroke="#fff" stroke-width="2" />`);
    }

    // 参考図（バリエーションのオーバーレイ）
    if (opts?.variationOverlay && opts.variationOverlay.moves.length > 0) {
        const alpha = opts.variationOverlay.alpha ?? 0.7;
        const fontSizeVar = Math.max(10, Math.floor(cell * 0.35));
        for (const m of opts.variationOverlay.moves) {
            const cx = margin + m.x * cell;
            const cy = margin + m.y * cell;
            const r = cell * 0.28;
            const fill = m.color === "b" ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
            const stroke = m.color === "b" ? "#111" : "#aaa";
            const textColor = m.color === "b" ? "#fff" : "#000";
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2" />`);
            parts.push(`<text x="${cx}" y="${cy + fontSizeVar/3}" text-anchor="middle" font-size="${fontSizeVar}" font-family="Segoe UI, Meiryo, sans-serif" fill="${textColor}">${m.label}</text>`);
        }
    }

    // 軸ラベル（要件: 左上基準。横軸は左から A..T（I をスキップ）、縦軸は上から 19..1）
    // 文字描画のためのスタイル
    const fontSize = Math.max(10, Math.floor(cell * 0.35));
    const textColor = "#222";

    // 列ラベル（上端）
    const colLabels: string[] = [];
    {
        let code = "A".charCodeAt(0);
        for (let i = 0; i < size; i++) {
            // I をスキップ
            if (code === "I".charCodeAt(0)) code++;
            colLabels.push(String.fromCharCode(code));
            code++;
        }
    }
    for (let i = 0; i < size; i++) {
        const x = margin + i * cell;
        const y = margin - Math.min(8, Math.max(4, Math.floor(cell * 0.2))); // 上の余白に収める
        parts.push(
            `<text x="${x}" y="${y}" fill="${textColor}" font-size="${fontSize}" font-family='Arial, Helvetica, "sans-serif"' text-anchor="middle" dominant-baseline="ideographic">${colLabels[i]}</text>`
        );
    }

    // 行ラベル（左端）: 上から size..1
    for (let j = 0; j < size; j++) {
        const num = size - j;
        const x = margin - Math.min(8, Math.max(4, Math.floor(cell * 0.2)));
        const y = margin + j * cell + 0; // 線上に合わせる
        parts.push(
            `<text x="${x}" y="${y}" fill="${textColor}" font-size="${fontSize}" font-family='Arial, Helvetica, "sans-serif"' text-anchor="end" dominant-baseline="central">${num}</text>`
        );
    }

    // 右側パネル（解析結果のテキスト出力）
    let svgHeight = boardPx; // デフォルトは盤面高さ
    let totalWidth = rp ? boardPx + gapPx + panelWidth : boardPx;
    if (rp && rp.lines && rp.lines.length > 0) {
        const panelX = boardPx + gapPx;

        // タイポグラフィ計算
        const title = rp.title ?? "【解析結果】";
        const titleSize = Math.max(12, Math.floor(fontSize * 1.1));
        const lineSize = Math.max(11, Math.floor(fontSize * 0.95));
        const lineHeight = Math.floor(lineSize * 1.5);
        const textLeft = panelX + 12;

        // 簡易折り返し：半角/全角を区別しない文字数ベース。
        // CJK を想定して 1 文字 ≒ 0.9em 程度で見積もる（0.6 だと幅を過小評価し見切れの原因になる）。
        const charW = Math.max(6, Math.floor(lineSize * 0.9));

        // パネル幅が未指定だった場合、テキスト量から動的に再算出する。
        if (!rp.width) {
            // タイトル含め、各行の最長文字数を見積もり、1行に収まるだけの幅を確保。
            const longestLines = rp.lines.reduce((m, s) => Math.max(m, (s ?? "").length), 0);
            const longest = Math.max(longestLines, (title ?? "").length);
            const estimatedWidth = longest * charW + 24; // 左右余白 12px ずつ
            const minW = Math.max(360, Math.floor(cell * 10));
            const maxW = Math.max(720, Math.floor(cell * 20)); // 上限を緩めて幅いっぱいに対応
            panelWidth = Math.min(Math.max(minW, estimatedWidth), maxW);
            totalWidth = boardPx + gapPx + panelWidth; // 再計算
        }

        const usableWidth = Math.max(10, panelWidth - 24); // 左右余白 12px ずつ
        const maxChars = Math.max(8, Math.floor(usableWidth / charW));

        function wrapLine(raw: string): string[] {
            if (!raw) return [""];
            // 既存改行は呼び出し側で分割済み。ここでは長い1行を分割。
            const res: string[] = [];
            let t = raw;
            while (t.length > maxChars) {
                // できれば空白や句読点で切る
                let cut = t.lastIndexOf(" ", maxChars);
                if (cut < Math.floor(maxChars * 0.6)) {
                    const puncts = ["、", "。", ",", ".", "・", ":", ";", "（", "）", "(", ")"]; // 直前優先
                    cut = -1;
                    for (const p of puncts) {
                        const idx = t.lastIndexOf(p, maxChars);
                        if (idx >= Math.floor(maxChars * 0.5)) { cut = idx + 1; break; }
                    }
                }
                if (cut <= 0) cut = maxChars;
                res.push(t.slice(0, cut).trim());
                t = t.slice(cut);
            }
            res.push(t);
            return res;
        }

        // レイアウト先に計算して高さを決定
        let yMeasure = margin + Math.floor(titleSize * 1.6);
        for (const raw of rp.lines) {
            if (raw.trim() === "") {
                yMeasure += Math.floor(lineHeight * 0.7);
                continue;
            }
            const wrapped = wrapLine(raw);
            yMeasure += wrapped.length * lineHeight;
        }
        // 下マージン
        yMeasure += margin;
        svgHeight = Math.max(boardPx, yMeasure);

        // 背景（高さは svgHeight に拡張）
        parts.push(`<rect x="${panelX}" y="0" width="${panelWidth}" height="${svgHeight}" fill="#ffffff" stroke="#ddd" stroke-width="1" />`);

        // 見出し
        let y = margin;
        parts.push(`<text x="${textLeft}" y="${y}" fill="#111" font-size="${titleSize}" font-weight="700" font-family='Arial, Helvetica, "sans-serif"'>${escapeXml(title)}</text>`);
        y += Math.floor(titleSize * 1.6);

        for (const raw of rp.lines) {
            if (raw.trim() === "") {
                y += Math.floor(lineHeight * 0.7);
                continue;
            }
            const wrapped = wrapLine(raw);
            for (const segRaw of wrapped) {
                const line = escapeXml(segRaw);
                parts.push(`<text x="${textLeft}" y="${y}" fill="#222" font-size="${lineSize}" font-family='Arial, Helvetica, "sans-serif"'>${line}</text>`);
                y += lineHeight;
            }
        }
        // totalWidth は既に正しい
    }

    return (
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${svgHeight}" viewBox="0 0 ${totalWidth} ${svgHeight}">` +
        parts.join("\n") +
        `</svg>`
    );
}

// 子SVGを縦に連結して1つのSVGにするユーティリティ
function composeMultiPageSvg(svgs: string[]): string {
    type Frag = { width: number; height: number; inner: string };
    const frags: Frag[] = [];
    for (const s of svgs) {
        // 幅と高さを抽出
        const wM = s.match(/\bwidth="(\d+(?:\.\d+)?)"/);
        const hM = s.match(/\bheight="(\d+(?:\.\d+)?)"/);
        const width = wM ? Number(wM[1]) : 1000;
        const height = hM ? Number(hM[1]) : 1000;
        // 内部コンテンツ抽出
        const innerM = s.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
        const inner = innerM ? innerM[1].trim() : s;
        frags.push({ width, height, inner });
    }
    // 各ページの間に余白を入れて、碁盤がくっつかないようにする
    const pageGap = 40; // px の縦方向スペース
    const totalHeight = frags.reduce((acc, f, idx) => acc + f.height + (idx > 0 ? pageGap : 0), 0);
    const maxWidth = frags.reduce((acc, f) => Math.max(acc, f.width), 0);
    let y = 0;
    const parts: string[] = [];
    for (const f of frags) {
        parts.push(`<g transform="translate(0, ${y})">`);
        parts.push(f.inner);
        parts.push(`</g>`);
        y += f.height + pageGap;
    }
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="${maxWidth}" height="${totalHeight}" viewBox="0 0 ${maxWidth} ${totalHeight}">` +
        parts.join("\n") +
        `</svg>`
    );
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function ensureDirSync(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getSessionDir(): string {
    const base = process.env.HC_BASE_DIR || path.join(process.cwd(), "HC");
    const ts = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const name = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const dir = path.join(base, name);
    ensureDirSync(dir);
    return dir;
}

// SGF のファイル名単位で出力ディレクトリを切る（拡張子を除いたベース名）
// 例) HC/対局A/ に move_XXXX.svg 等を保存。同じ SGF を解析する限り同一ディレクトリを再利用する。
function getOutputDirForSgf(sgfPath: string): string {
    const base = process.env.HC_BASE_DIR || path.join(process.cwd(), "HC");
    const sgfBase = path.basename(sgfPath, path.extname(sgfPath));
    // 安全なディレクトリ名に変換（日本語や空白も一応許容するが、念のためNG文字は下線に）
    const safe = sgfBase.replace(/[^\p{L}\p{N}._\- ]/gu, "_").trim() || "sgf";
    const dir = path.join(base, safe);
    ensureDirSync(dir);
    return dir;
}

function saveSvg(filePath: string, svg: string) {
    fs.writeFileSync(filePath, svg, "utf8");
}

// GTP座標を盤上のx,y(左上原点,0始まり)に変換
function gtpToPoint(gtp: string, size: number): { x: number; y: number } | null {
    if (!gtp) return null;
    const up = gtp.trim().toUpperCase();
    if (up === "PASS" || up === "RESIGN") return null;
    const m = up.match(/^([A-T])(\d{1,2})$/);
    if (!m) return null;
    let colChar = m[1].charCodeAt(0);
    const row = Number(m[2]);
    if (!Number.isFinite(row)) return null;
    // A..T (Iをスキップ)
    if (colChar > "H".charCodeAt(0)) colChar -= 1; // I をスキップの逆変換
    const colIdx = colChar - "A".charCodeAt(0);
    if (colIdx < 0 || colIdx >= size) return null;
    const fromBottom = row;
    const yFromTop = size - fromBottom;
    if (yFromTop < 0 || yFromTop >= size) return null;
    return { x: colIdx, y: yFromTop };
}


server.addTool({
    name: "katago_replay",
    description: "Start KataGo (GTP), set up board from sgf/test.sgf via play commands, then quit. Returns startup and replay logs.",
    parameters: z.object({}),
    execute: async () => {

        dotenv.config();
        const sgfPathFromEnv = requireEnv("KATAGO_SGF_PATH");
        const kataExePath    = requireEnv("KATAGO_EXE");
        const kataModelPath  = requireEnv("KATAGO_MODEL_PATH");
        const kataConfigPath = requireEnv("KATAGO_CONFIG_PATH");

        // SGF 読み込み（ESM 環境で __dirname が未定義になる場合があるため、process.cwd() を基準に解決）
        //const sgfPath = path.resolve(process.cwd(), "sgf", "test.sgf");
        const sgfPath = sgfPathFromEnv;
        if (!fs.existsSync(sgfPath)) {
            return JSON.stringify({ ok: false, error: `SGF ファイルが見つかりません: ${sgfPath}` });
        }
        const sgfText = fs.readFileSync(sgfPath, "utf8");
        const parsed = parseSgfFromText(sgfText);
        const totalMoves = parsed.moves.length;

        // KataGo 起動）
        const args = ["gtp", "-model", kataModelPath, "-config", kataConfigPath];

        const kata = spawn(kataExePath, args, { cwd: path.dirname(kataExePath), windowsHide: true });

        const exitPromise = new Promise<number | null>((resolve) => {
            kata.on("close", (code) => resolve(code));
        });

        function send(cmd: string) {
            // play は大量になるので控えめに
            try { kata.stdin.write(cmd + "\n"); } catch (e: any) {  }
        }

        // ほんの少し待ってから送信開始（起動安定化）
        await new Promise((r) => setTimeout(r, 800));

        // 盤面初期化
        send(`boardsize ${parsed.size}`);
        send(`komi ${parsed.komi}`);
        send("clear_board");

        // 置き石
        for (const p of parsed.ab) send(`play b ${sgfToGtpCoord(p, parsed.size)}`);
        for (const p of parsed.aw) send(`play w ${sgfToGtpCoord(p, parsed.size)}`);

        // 主変化全手を反映
        for (const mv of parsed.moves) {
            send(`play ${mv.color} ${sgfToGtpCoord(mv.sgf, parsed.size)}`);
        }

        // 少し待って quit
        await new Promise((r) => setTimeout(r, 300));
        send("quit");

        const code = await exitPromise;
        return JSON.stringify({ ok: true, boardSize: parsed.size, komi: parsed.komi, totalMoves});
    },
});

// KataGo 解析ツール: SGF を読み込み、指定手数まで盤面を再現し、kata-analyze の info を集計して返却
server.addTool({
    name: "analyze_katago",
    description: "Analyze a Go position from SGF at a specific move using KataGo kata-analyze and return top candidates.",
    parameters: z.object({
        moveNumber: z.number().int().min(0).describe("解析する手数 (0=初期局面)"),
        timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
        topN: z.number().int().min(1).max(10).optional().default(5),
        // デモ側に合わせやすいよう visits を引数に昇格
        visits: z
            .number()
            .int()
            .min(100)
            .max(20000)
            .optional()
            .default(2000)
            .describe("kata-analyze に与える訪問数(探索量)。未指定時は 2000"),
        // 参考図: 最善手のPVから先読み表示する手数（0なら無効）
        previewDepth: z.number().int().min(0).max(10).optional().default(0)
    }),
    execute: async (args) => {
        dotenv.config();

        const sgfPathFromEnv = requireEnv("KATAGO_SGF_PATH");
        const kataExePath    = requireEnv("KATAGO_EXE");
        const kataModelPath  = requireEnv("KATAGO_MODEL_PATH");
        const kataConfigPath = requireEnv("KATAGO_CONFIG_PATH");

        const { moveNumber, timeoutMs, topN, visits, previewDepth } = args as { moveNumber: number; timeoutMs?: number; topN?: number; visits?: number; previewDepth?: number };

        if (!fs.existsSync(sgfPathFromEnv)) {
            throw new Error(`SGF ファイルが見つかりません: ${sgfPathFromEnv}`);
        }
        const sgfText = fs.readFileSync(sgfPathFromEnv, "utf8");
        const parsed = parseSgfFromText(sgfText);

        // 出力ディレクトリの準備（SGFファイル名ごとの固定ディレクトリに保存）
        const outDir = getOutputDirForSgf(sgfPathFromEnv);
        const baseName = `move_${String(moveNumber).padStart(4, "0")}`;
        const imagePath = path.join(outDir, `${baseName}.svg`);

        type Cand = { move: string; visits?: number; winrate?: number; scoreLead?: number; pv?: string };
        const candMap = new Map<string, Cand>();

        const kata = spawn(kataExePath, ["gtp", "-model", kataModelPath, "-config", kataConfigPath], {
            cwd: path.dirname(kataExePath),
            windowsHide: true,
        });

        let analyzing = false;
        const infoHandler = (text: string) => {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                if (!/^info\b/.test(line)) continue;
                const moveM = line.match(/\bmove\s+([A-Ta-t][0-9]+|pass|resign)\b/);
                if (!moveM) continue;
                const move = moveM[1].toUpperCase();
                const visitsM = line.match(/\bvisits\s+(\d+)/i);
                const winM = line.match(/\bwinrate\s+([0-9]*\.?[0-9]+)/i);
                const scoreM = line.match(/\bscoreLead\s+(-?[0-9]*\.?[0-9]+)/i);
                const pvM = line.match(/\bpv\s+(.+)$/i);

                let wr: number | undefined;
                if (winM) {
                    const v = Number(winM[1]);
                    if (Number.isFinite(v)) wr = v <= 1 ? v * 100 : v;
                }
                const prev = candMap.get(move) || { move } as Cand;
                candMap.set(move, {
                    move,
                    visits: visitsM ? Number(visitsM[1]) : prev.visits,
                    winrate: wr !== undefined ? wr : prev.winrate,
                    scoreLead: scoreM ? Number(scoreM[1]) : prev.scoreLead,
                    pv: pvM ? pvM[1].trim() : prev.pv,
                });
            }
        };

        kata.stdout.on("data", (buf: Buffer) => { if (analyzing) infoHandler(buf.toString()); });
        kata.stderr.on("data", (buf: Buffer) => { if (analyzing) infoHandler(buf.toString()); });

        function send(cmd: string) {
            try { kata.stdin.write(cmd + "\n"); } catch {}
        }

        // 起動安定のため少し待機
        await new Promise(r => setTimeout(r, 800));

        // 盤面初期化と設定（server.ts はここまで実装済のため、同等処理を記述）
        send(`boardsize ${parsed.size}`);
        send(`komi ${parsed.komi}`);
        send("clear_board");

        // 置き石
        for (const p of parsed.ab) send(`play b ${sgfToGtpCoord(p, parsed.size)}`);
        for (const p of parsed.aw) send(`play w ${sgfToGtpCoord(p, parsed.size)}`);

        // 指定手数まで主変化を再現
        const upto = Math.max(0, Math.min(moveNumber -1, parsed.moves.length));
        for (let i = 0; i < upto; i++) {
            const mv = parsed.moves[i];
            send(`play ${mv.color} ${sgfToGtpCoord(mv.sgf, parsed.size)}`);
        }

        // 手番判定
        const totalPlays = parsed.ab.length + parsed.aw.length + upto;
        const sideToMove: "b" | "w" = totalPlays % 2 === 0 ? "b" : "w";

        // 解析開始
        analyzing = true;
        // visits を指定して解析を開始（未指定の場合は Zod の default=2000 が適用）
        send(`kata-analyze ${visits ?? 2000}`);

        // 規定時間だけ解析を進める
        await new Promise(r => setTimeout(r, timeoutMs));
        // 停止要求を送っても直後に有益な info が出力されうるため、
        // 200ms 程度は analyzing=true のまま維持して取り込み続ける
        send("stop");
        await new Promise(r => setTimeout(r, 200));
        analyzing = false;

        // 集計
        const cands = Array.from(candMap.values());
        cands.sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1) || (b.winrate ?? -1) - (a.winrate ?? -1));
        const top = cands.slice(0, topN);
        const best = top[0];

        let blackWinPct: number | undefined;
        let whiteWinPct: number | undefined;
        if (best?.winrate !== undefined && Number.isFinite(best.winrate)) {
            if (sideToMove === "b") {
                blackWinPct = best.winrate;
                whiteWinPct = 100 - best.winrate;
            } else {
                whiteWinPct = best.winrate;
                blackWinPct = 100 - best.winrate;
            }
        }

        const sideLabel = sideToMove === "b" ? "黒番" : "白番";
        const summary = best
            ? `手番: ${sideLabel} / 第1候補: ${best.move} / 勝率(手番側): ${best.winrate?.toFixed(1) ?? "-"}%`
            : "解析情報を取得できませんでした";

        // 解析結果の右パネル用テキスト行を構築
        const lines: string[] = [];
        lines.push(`結論（${moveNumber}手目の最善手）`);
        if (best) {
            lines.push(`最善手: ${best.move}（${sideLabel}）`);
            lines.push(`期待勝率: 約 ${(best.winrate ?? 0).toFixed(1)}%`);
            if (best.scoreLead !== undefined && Number.isFinite(best.scoreLead)) {
                const sl = best.scoreLead;
                const sign = sl >= 0 ? "+" : "";
                lines.push(`形勢評価（リード）: 約 ${sign}${sl.toFixed(1)} 目前後`);
            }
        } else {
            lines.push(`最善手: 取得不可`);
            lines.push(`期待勝率: -`);
            lines.push(`形勢評価（リード）: -`);
        }
        lines.push("");
        lines.push("代替候補（参考）");
        const alt = top.slice(1);
        if (alt.length > 0) {
            for (const c of alt) {
                const wr = c.winrate !== undefined ? `${c.winrate.toFixed(1)}%` : "-";
                const sl = c.scoreLead !== undefined && Number.isFinite(c.scoreLead)
                    ? `${c.scoreLead >= 0 ? "+" : ""}${c.scoreLead.toFixed(1)}目`
                    : undefined;
                const leadPart = sl ? `、形勢 ${sl}` : "";
                lines.push(`${c.move}（${sideLabel}）: 勝率 ~${wr}${leadPart}`);
            }
        } else {
            lines.push("候補を取得できませんでした");
        }

        // 画像生成（1ファイルに3ページを縦連結）
        try {
            const pageSvgs: string[] = [];

            // Page1: 全手順 + 対局情報
            {
                const { stones } = buildPosition(parsed, parsed.moves.length + 1);
                const infoLines: string[] = [];
                const blackName = parsed.pb || "-";
                const whiteName = parsed.pw || "-";
                const haText = (parsed.ha && parsed.ha >= 2) ? `置き石 ${parsed.ha}` : "互先";
                infoLines.push(`黒番: ${blackName}`);
                infoLines.push(`白番: ${whiteName}`);
                infoLines.push(`手合い: ${haText}、コミ ${parsed.komi}`);
                infoLines.push(`結果: ${parsed.re ?? "-"}`);
                const svg1 = renderBoardSVG(parsed.size, stones, { rightPanel: { lines: infoLines, title: "【対局情報（全手順）】" } });
                pageSvgs.push(svg1);
            }

            // Page2: 解析結果（現行実装と同等）
            let overlay: VariationOverlay | undefined;
            let refLines: string[] | undefined;
            {
                const { stones, last } = buildPosition(parsed, moveNumber);
                if ((previewDepth ?? 0) > 0 && best?.pv) {
                    const pvMoves = best.pv.trim().split(/\s+/).filter(Boolean);
                    const depth = Math.min(previewDepth ?? 0, pvMoves.length);
                    const toPlay = sideToMove;
                    const colorAt = (k: number): "b"|"w" => (k % 2 === 0 ? toPlay : (toPlay === "b" ? "w" : "b"));
                    const points: { x:number; y:number; color: "b"|"w"; label:number }[] = [];
                    for (let i = 0; i < depth; i++) {
                        const pt = gtpToPoint(pvMoves[i], parsed.size);
                        if (!pt) continue;
                        points.push({ x: pt.x, y: pt.y, color: colorAt(i), label: i + 1 });
                    }
                    if (points.length > 0) overlay = { moves: points, alpha: 0.7 };
                    if (points.length > 0) {
                        lines.push("");
                        lines.push(`参考図（最善手の想定 ${points.length}手）`);
                        const seq = points.map((p, idx) => `${idx+1}=${best!.pv!.trim().split(/\s+/)[idx]}`).join(" → ");
                        lines.push(seq);
                        refLines = ["参考図（最善手の想定）", seq];
                    }
                }
                // 2枚目は参考図の石を盤上に重ねない（右パネルの文言のみ表示）
                const svg2 = renderBoardSVG(parsed.size, stones, { last, rightPanel: { lines, title: "【解析結果】" } });
                pageSvgs.push(svg2);
            }

            // Page3: 参考図ページ（2枚目の参考図を単独で表示）
            {
                const { stones } = buildPosition(parsed, moveNumber);
                const panel = refLines ?? ["参考図", overlay ? "(最善手の想定手順)" : "(データなし)"];
                const svg3 = renderBoardSVG(parsed.size, stones, { rightPanel: { lines: panel, title: "【参考図】" }, variationOverlay: overlay });
                pageSvgs.push(svg3);
            }

            const merged = composeMultiPageSvg(pageSvgs);
            saveSvg(imagePath, merged);
        } catch (e) {
            // 画像生成エラーは返却を継続
        }

        // 終了
        try { send("quit"); } catch {}

        return JSON.stringify({
            sideToMove,
            moveNumber,
            boardSize: parsed.size,
            komi: parsed.komi,
            topMoves: top,
            blackWinPct,
            whiteWinPct,
            summaryText: summary,
            outDir,
            imagePath,
        });
    }
});

// 悪手/良手 判定ツール: SGF を読み込み、指定の手の直前まで盤面を再現して kata-analyze を走らせ、
// 実際に打たれた手の評価と最善手との差分から、良手/疑問手/悪手/大悪手 を判定します。
server.addTool({
    name: "analyze_move_quality",
    description: "指定の手(手数)が良手か悪手かを、SGFを読み込み盤面を再現した上でKataGoのkata-analyze結果から判定します。",
    parameters: z.object({
        moveNumber: z.number().int().min(1).describe("評価する手数 (1始まり)。この手の直前まで盤面を再現して解析します。"),
        timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
        visits: z.number().int().min(100).max(20000).optional().default(2000)
            .describe("kata-analyze に与える訪問数(探索量)。未指定時は 2000"),
        topN: z.number().int().min(1).max(15).optional().default(6),
        // 判定閾値（勝率差、手番側の勝率での差分/%）
        goodWithinPct: z.number().min(0).max(20).optional().default(1.0)
            .describe("最善手との差がこの%未満なら良手"),
        inaccuracyMaxPct: z.number().min(0).max(50).optional().default(3.0)
            .describe("良手でなければ、この%未満なら疑問手"),
        mistakeMaxPct: z.number().min(0).max(100).optional().default(10.0)
            .describe("疑問手でなければ、この%未満なら悪手。以上は大悪手"),
        generateSvg: z.boolean().optional().default(true)
            .describe("右パネル付きの要約SVGを生成して保存するか"),
        // 参考図: 最善手のPVから先読み表示する手数（0なら無効、推奨2〜3）
        previewDepth: z.number().int().min(0).max(10).optional().default(0)
    }),
    execute: async (args) => {
        dotenv.config();

        const sgfPathFromEnv = requireEnv("KATAGO_SGF_PATH");
        const kataExePath    = requireEnv("KATAGO_EXE");
        const kataModelPath  = requireEnv("KATAGO_MODEL_PATH");
        const kataConfigPath = requireEnv("KATAGO_CONFIG_PATH");

        const {
            moveNumber,
            timeoutMs,
            visits,
            topN,
            goodWithinPct,
            inaccuracyMaxPct,
            mistakeMaxPct,
            generateSvg,
            previewDepth,
        } = args as {
            moveNumber: number; timeoutMs?: number; visits?: number; topN?: number;
            goodWithinPct?: number; inaccuracyMaxPct?: number; mistakeMaxPct?: number; generateSvg?: boolean; previewDepth?: number;
        };

        if (!fs.existsSync(sgfPathFromEnv)) {
            throw new Error(`SGF ファイルが見つかりません: ${sgfPathFromEnv}`);
        }
        const sgfText = fs.readFileSync(sgfPathFromEnv, "utf8");
        const parsed = parseSgfFromText(sgfText);

        if (moveNumber < 1 || moveNumber > parsed.moves.length) {
            throw new Error(`moveNumber=${moveNumber} は範囲外です。1〜${parsed.moves.length} の間で指定してください。`);
        }

        // 解析対象の手（実際に打たれた手）
        const played = parsed.moves[moveNumber - 1];

        // 出力先（SGFファイル名ごとの固定ディレクトリ）
        const outDir = getOutputDirForSgf(sgfPathFromEnv);
        const baseName = `quality_move_${String(moveNumber).padStart(4, "0")}`;
        const imagePath = path.join(outDir, `${baseName}.svg`);

        type Cand = { move: string; visits?: number; winrate?: number; scoreLead?: number; pv?: string };
        const candMap = new Map<string, Cand>();

        const kata = spawn(kataExePath, ["gtp", "-model", kataModelPath, "-config", kataConfigPath], {
            cwd: path.dirname(kataExePath),
            windowsHide: true,
        });

        let analyzing = false;
        const infoHandler = (text: string) => {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                if (!/^info\b/.test(line)) continue;
                const moveM = line.match(/\bmove\s+([A-Ta-t][0-9]+|pass|resign)\b/);
                if (!moveM) continue;
                const move = moveM[1].toUpperCase();
                const visitsM = line.match(/\bvisits\s+(\d+)/i);
                const winM = line.match(/\bwinrate\s+([0-9]*\.?[0-9]+)/i);
                const scoreM = line.match(/\bscoreLead\s+(-?[0-9]*\.?[0-9]+)/i);
                const pvM = line.match(/\bpv\s+(.+)$/i);

                let wr: number | undefined;
                if (winM) {
                    const v = Number(winM[1]);
                    if (Number.isFinite(v)) wr = v <= 1 ? v * 100 : v;
                }
                const prev = candMap.get(move) || { move } as Cand;
                candMap.set(move, {
                    move,
                    visits: visitsM ? Number(visitsM[1]) : prev.visits,
                    winrate: wr !== undefined ? wr : prev.winrate,
                    scoreLead: scoreM ? Number(scoreM[1]) : prev.scoreLead,
                    pv: pvM ? pvM[1].trim() : prev.pv,
                });
            }
        };

        kata.stdout.on("data", (buf: Buffer) => { if (analyzing) infoHandler(buf.toString()); });
        kata.stderr.on("data", (buf: Buffer) => { if (analyzing) infoHandler(buf.toString()); });

        function send(cmd: string) {
            try { kata.stdin.write(cmd + "\n"); } catch {}
        }

        // 起動安定のため少し待機
        await new Promise(r => setTimeout(r, 800));

        // 盤面設定
        send(`boardsize ${parsed.size}`);
        send(`komi ${parsed.komi}`);
        send("clear_board");
        for (const p of parsed.ab) send(`play b ${sgfToGtpCoord(p, parsed.size)}`);
        for (const p of parsed.aw) send(`play w ${sgfToGtpCoord(p, parsed.size)}`);
        // 解析は着手直前の局面で実施
        const upto = Math.max(0, Math.min(moveNumber - 1, parsed.moves.length));
        for (let i = 0; i < upto; i++) {
            const mv = parsed.moves[i];
            send(`play ${mv.color} ${sgfToGtpCoord(mv.sgf, parsed.size)}`);
        }

        // 手番は played.color と一致するはず
        const sideToMove: "b" | "w" = played.color;

        // 解析開始
        analyzing = true;
        send(`kata-analyze ${visits ?? 2000}`);

        await new Promise(r => setTimeout(r, timeoutMs));
        send("stop");
        await new Promise(r => setTimeout(r, 200));
        analyzing = false;

        // 候補まとめ
        const cands = Array.from(candMap.values());
        cands.sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1) || (b.winrate ?? -1) - (a.winrate ?? -1));
        const top = cands.slice(0, topN);
        const best = top[0];

        // 実際に打たれた手のGTP表記
        const playedGtp = sgfToGtpCoord(played.sgf, parsed.size).toUpperCase();
        const playedInfo = candMap.get(playedGtp);

        // 勝率差分（手番側基準）。どちらも取得できた場合のみ計算
        let diffWinratePct: number | undefined;
        let classification = "不明";
        if (best?.winrate !== undefined && playedInfo?.winrate !== undefined) {
            diffWinratePct = Math.max(0, best.winrate - playedInfo.winrate);
            if (diffWinratePct < (goodWithinPct ?? 1.0)) classification = "良手";
            else if (diffWinratePct < (inaccuracyMaxPct ?? 3.0)) classification = "疑問手";
            else if (diffWinratePct < (mistakeMaxPct ?? 10.0)) classification = "悪手";
            else classification = "大悪手";
        } else if (best?.winrate !== undefined && !playedInfo) {
            // 候補に現れないほど悪い可能性
            classification = "大悪手の可能性（候補外）";
        }

        // SVG 生成（1ファイルに3ページ: 全手順/判定/参考図）
        if (generateSvg) {
            try {
                const pageSvgs: string[] = [];

                // Page1: 全手順 + 対局情報
                {
                    const { stones } = buildPosition(parsed, parsed.moves.length + 1);
                    const infoLines: string[] = [];
                    const blackName = parsed.pb || "-";
                    const whiteName = parsed.pw || "-";
                    const haText = (parsed.ha && parsed.ha >= 2) ? `置き石 ${parsed.ha}` : "互先";
                    infoLines.push(`黒番: ${blackName}`);
                    infoLines.push(`白番: ${whiteName}`);
                    infoLines.push(`手合い: ${haText}、コミ ${parsed.komi}`);
                    infoLines.push(`結果: ${parsed.re ?? "-"}`);
                    const svg1 = renderBoardSVG(parsed.size, stones, { rightPanel: { lines: infoLines, title: "【対局情報（全手順）】" } });
                    pageSvgs.push(svg1);
                }

                // Page2: 良し悪し解析（現行の内容）
                let overlay: VariationOverlay | undefined;
                let refLines: string[] | undefined;
                {
                    const { stones, last } = buildPosition(parsed, moveNumber - 1);
                    const sideLabel = sideToMove === "b" ? "黒番" : "白番";
                    const lines: string[] = [];
                    lines.push(`手数 ${moveNumber}: ${sideLabel} 実戦の着手 = ${playedGtp}`);
                    if (best) lines.push(`最善手: ${best.move} (勝率 ~${best.winrate?.toFixed(1) ?? "-"}%)`);
                    if (playedInfo?.winrate !== undefined) {
                        lines.push(`実戦手の勝率: ~${playedInfo.winrate.toFixed(1)}%`);
                    } else {
                        lines.push(`実戦手の評価: 候補に出現せず`);
                    }
                    if (diffWinratePct !== undefined) {
                        lines.push(`最善との差: ${diffWinratePct.toFixed(1)}%`);
                    }
                    lines.push(`判定: ${classification}`);

                    if ((previewDepth ?? 0) > 0 && best?.pv) {
                        const pvMoves = best.pv.trim().split(/\s+/).filter(Boolean);
                        const depth = Math.min(previewDepth ?? 0, pvMoves.length);
                        const toPlay = sideToMove; // この着手での手番
                        const colorAt = (k: number): "b"|"w" => (k % 2 === 0 ? toPlay : (toPlay === "b" ? "w" : "b"));
                        const points: { x:number; y:number; color: "b"|"w"; label:number }[] = [];
                        for (let i = 0; i < depth; i++) {
                            const pt = gtpToPoint(pvMoves[i], parsed.size);
                            if (!pt) continue;
                            points.push({ x: pt.x, y: pt.y, color: colorAt(i), label: i + 1 });
                        }
                        if (points.length > 0) overlay = { moves: points, alpha: 0.7 };
                        if (points.length > 0) {
                            lines.push("");
                            lines.push(`参考図（最善手の想定 ${points.length}手）`);
                            const seq = points.map((p, idx) => `${idx+1}=${pvMoves[idx]}`).join(" → ");
                            lines.push(seq);
                            refLines = ["参考図（最善手の想定）", seq];
                        }
                    }

                    // 2枚目は参考図の石を盤上に重ねない（右パネルの文言のみ表示）
                    const svg2 = renderBoardSVG(parsed.size, stones, {
                        last,
                        rightPanel: { lines, title: "【手の良し悪し解析】" },
                    });
                    pageSvgs.push(svg2);
                }

                // Page3: 参考図ページ
                {
                    const { stones } = buildPosition(parsed, moveNumber - 1);
                    const panel = refLines ?? ["参考図", overlay ? "(最善手の想定手順)" : "(データなし)"];
                    const svg3 = renderBoardSVG(parsed.size, stones, { rightPanel: { lines: panel, title: "【参考図】" }, variationOverlay: overlay });
                    pageSvgs.push(svg3);
                }

                const merged = composeMultiPageSvg(pageSvgs);
                saveSvg(imagePath, merged);
            } catch {}
        }

        try { send("quit"); } catch {}

        return JSON.stringify({
            moveNumber,
            colorPlayed: played.color,
            playedMove: playedGtp,
            sideToMove,
            boardSize: parsed.size,
            komi: parsed.komi,
            classification,
            diffWinratePct,
            bestMove: best?.move,
            bestWinrate: best?.winrate,
            playedWinrate: playedInfo?.winrate,
            topMoves: top,
            outDir,
            imagePath,
            previewDepth,
        });
    }
});

// 任意のテキスト要約（結論/最善手/期待値/代替候補/簡単な解説 など）を右パネルに描画したSVGを生成するツール
// 既存の盤面復元・描画ユーティリティを再利用し、SGFの指定手数までの局面を左側に、右側に与えられたテキストをそのまま表示します。
server.addTool({
    name: "render_summary_svg",
    description: "指定手数までの盤面と、与えられた要約テキスト(結論/最善手/期待値/代替候補/簡単な解説など)を右パネルに描画したSVGを生成します。",
    parameters: z.object({
        moveNumber: z.number().int().min(0).describe("盤面を再現する手数 (0=初期局面)"),
        panelText: z.string().min(1).describe("右パネルに表示する複数行テキスト。\\nで改行します。"),
        title: z.string().optional().describe("右パネルの見出し(省略時は【解析結果】)"),
    }),
    execute: async (args) => {
        dotenv.config();

        const { moveNumber, panelText, title } = args as { moveNumber: number; panelText: string; title?: string };

        const sgfPathFromEnv = requireEnv("KATAGO_SGF_PATH");
        if (!fs.existsSync(sgfPathFromEnv)) {
            throw new Error(`SGF ファイルが見つかりません: ${sgfPathFromEnv}`);
        }

        const sgfText = fs.readFileSync(sgfPathFromEnv, "utf8");
        const parsed = parseSgfFromText(sgfText);

        const outDir = getOutputDirForSgf(sgfPathFromEnv);
        const baseName = `summary_move_${String(moveNumber).padStart(4, "0")}`;
        const imagePath = path.join(outDir, `${baseName}.svg`);

        // パネル行へ分割（表示は renderBoardSVG 内でエスケープされる）
        const lines = panelText.split(/\r?\n/);

        // 盤面構築と描画
        const { stones, last } = buildPosition(parsed, moveNumber);
        const svg = renderBoardSVG(parsed.size, stones, {
            last,
            rightPanel: {
                lines,
                title: title ?? "【解析結果】",
            },
        });

        saveSvg(imagePath, svg);

        return JSON.stringify({
            ok: true,
            boardSize: parsed.size,
            komi: parsed.komi,
            moveNumber,
            outDir,
            imagePath,
        });
    }
});

server.start({
    transportType: "stdio",
});