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
function parseSgfFromText(sgfText) {
    function parseRootNumber(tag, fallback) {
        const m = sgfText.match(new RegExp(`${tag}\\[([^\\]]*)\\]`, "i"));
        if (!m)
            return fallback;
        const v = Number(m[1]);
        return Number.isFinite(v) ? v : fallback;
    }
    function parseRootList(tag) {
        const tagPos = sgfText.search(new RegExp(`${tag}\\[`, "i"));
        if (tagPos < 0)
            return [];
        const slice = sgfText.slice(tagPos);
        const items = [];
        // SGF の [ ... ] を抽出する正規表現（リテラルの [ と ] は 1 つのバックスラッシュでエスケープ）
        const bracketRe = /\[([^\]]*)\]/g;
        let m;
        while ((m = bracketRe.exec(slice)) !== null) {
            items.push(m[1] || "");
        }
        return items;
    }
    function parseMoves() {
        const moves = [];
        // 手の表現 ";B[aa]" / ";W[bb]" を抽出
        const re = /;([BW])\[([^\]]*)\]/g;
        let m;
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
    };
}
function sgfToGtpCoord(sgfPoint, size) {
    if (!sgfPoint || sgfPoint.length !== 2)
        return "pass";
    const ax = sgfPoint.charCodeAt(0) - 97;
    const ay = sgfPoint.charCodeAt(1) - 97;
    if (ax < 0 || ay < 0 || ax >= size || ay >= size)
        return "pass";
    const colIdx = ax;
    const rowFromBottom = size - ay;
    let colCode = "A".charCodeAt(0) + colIdx;
    if (colCode >= "I".charCodeAt(0))
        colCode += 1; // I 列をスキップ
    const col = String.fromCharCode(colCode);
    return `${col}${rowFromBottom}`;
}
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`環境変数 ${name} が設定されていません (.env を確認してください)`);
    }
    return value;
}
function sgfToPoint(sgfPoint, size) {
    if (!sgfPoint || sgfPoint.length !== 2)
        return null;
    const ax = sgfPoint.charCodeAt(0) - 97; // 'a' -> 0
    const ay = sgfPoint.charCodeAt(1) - 97;
    if (ax < 0 || ay < 0 || ax >= size || ay >= size)
        return null;
    // SGF は左上原点。SVG でも左上原点で描画するため変換不要
    return { x: ax, y: ay };
}
function buildPosition(parsed, uptoMove) {
    const stones = [];
    const size = parsed.size;
    // 置き石
    for (const p of parsed.ab) {
        const pt = sgfToPoint(p, size);
        if (pt)
            stones.push({ ...pt, color: "b" });
    }
    for (const p of parsed.aw) {
        const pt = sgfToPoint(p, size);
        if (pt)
            stones.push({ ...pt, color: "w" });
    }
    const n = Math.max(0, Math.min(uptoMove, parsed.moves.length));
    for (let i = 0; i < n; i++) {
        const mv = parsed.moves[i];
        const pt = sgfToPoint(mv.sgf, size);
        if (!pt)
            continue; // pass 等はスキップ
        stones.push({ ...pt, color: mv.color });
    }
    const last = stones.length > 0 ? stones[stones.length - 1] : undefined;
    return { stones, last };
}
function renderBoardSVG(size, stones, opts) {
    const cell = opts?.cell ?? 40;
    const margin = opts?.margin ?? 30;
    const boardPx = margin * 2 + cell * (size - 1);
    const parts = [];
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
    const hoshi = (() => {
        if (size === 19) {
            const pts = [3, 9, 15];
            const r = [];
            for (const i of pts)
                for (const j of pts)
                    r.push({ x: i, y: j });
            return r;
        }
        else if (size === 13) {
            const pts = [3, 6, 9];
            const r = [];
            for (const i of pts)
                for (const j of pts)
                    r.push({ x: i, y: j });
            return r;
        }
        else if (size === 9) {
            const pts = [2, 4, 6];
            const r = [];
            for (const i of pts)
                for (const j of pts)
                    r.push({ x: i, y: j });
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
        }
        else {
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#aaa" stroke-width="2" />`);
            parts.push(`<circle cx="${cx - r / 3}" cy="${cy - r / 3}" r="${r / 4}" fill="#fff" opacity="0.7" />`);
        }
    }
    // 直前手マーク
    const last = opts?.last;
    if (last) {
        const cx = margin + last.x * cell;
        const cy = margin + last.y * cell;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${cell * 0.15}" fill="#ff3b30" stroke="#fff" stroke-width="2" />`);
    }
    // 軸ラベル（要件: 左上基準。横軸は左から A..T（I をスキップ）、縦軸は上から 19..1）
    // 文字描画のためのスタイル
    const fontSize = Math.max(10, Math.floor(cell * 0.35));
    const textColor = "#222";
    // 列ラベル（上端）
    const colLabels = [];
    {
        let code = "A".charCodeAt(0);
        for (let i = 0; i < size; i++) {
            // I をスキップ
            if (code === "I".charCodeAt(0))
                code++;
            colLabels.push(String.fromCharCode(code));
            code++;
        }
    }
    for (let i = 0; i < size; i++) {
        const x = margin + i * cell;
        const y = margin - Math.min(8, Math.max(4, Math.floor(cell * 0.2))); // 上の余白に収める
        parts.push(`<text x="${x}" y="${y}" fill="${textColor}" font-size="${fontSize}" font-family='Arial, Helvetica, "sans-serif"' text-anchor="middle" dominant-baseline="ideographic">${colLabels[i]}</text>`);
    }
    // 行ラベル（左端）: 上から size..1
    for (let j = 0; j < size; j++) {
        const num = size - j;
        const x = margin - Math.min(8, Math.max(4, Math.floor(cell * 0.2)));
        const y = margin + j * cell + 0; // 線上に合わせる
        parts.push(`<text x="${x}" y="${y}" fill="${textColor}" font-size="${fontSize}" font-family='Arial, Helvetica, "sans-serif"' text-anchor="end" dominant-baseline="central">${num}</text>`);
    }
    return (`<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="${boardPx}" height="${boardPx}" viewBox="0 0 ${boardPx} ${boardPx}">` +
        parts.join("\n") +
        `</svg>`);
}
function ensureDirSync(dir) {
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
function getSessionDir() {
    const base = process.env.HC_BASE_DIR || path.join(process.cwd(), "HC");
    const ts = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const name = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const dir = path.join(base, name);
    ensureDirSync(dir);
    return dir;
}
function saveSvg(filePath, svg) {
    fs.writeFileSync(filePath, svg, "utf8");
}
server.addTool({
    name: "katago_replay",
    description: "Start KataGo (GTP), set up board from sgf/test.sgf via play commands, then quit. Returns startup and replay logs.",
    parameters: z.object({}),
    execute: async () => {
        dotenv.config();
        const sgfPathFromEnv = requireEnv("KATAGO_SGF_PATH");
        const kataExePath = requireEnv("KATAGO_EXE");
        const kataModelPath = requireEnv("KATAGO_MODEL_PATH");
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
        const exitPromise = new Promise((resolve) => {
            kata.on("close", (code) => resolve(code));
        });
        function send(cmd) {
            // play は大量になるので控えめに
            try {
                kata.stdin.write(cmd + "\n");
            }
            catch (e) { }
        }
        // ほんの少し待ってから送信開始（起動安定化）
        await new Promise((r) => setTimeout(r, 800));
        // 盤面初期化
        send(`boardsize ${parsed.size}`);
        send(`komi ${parsed.komi}`);
        send("clear_board");
        // 置き石
        for (const p of parsed.ab)
            send(`play b ${sgfToGtpCoord(p, parsed.size)}`);
        for (const p of parsed.aw)
            send(`play w ${sgfToGtpCoord(p, parsed.size)}`);
        // 主変化全手を反映
        for (const mv of parsed.moves) {
            send(`play ${mv.color} ${sgfToGtpCoord(mv.sgf, parsed.size)}`);
        }
        // 少し待って quit
        await new Promise((r) => setTimeout(r, 300));
        send("quit");
        const code = await exitPromise;
        return JSON.stringify({ ok: true, boardSize: parsed.size, komi: parsed.komi, totalMoves });
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
    }),
    execute: async (args) => {
        dotenv.config();
        const sgfPathFromEnv = requireEnv("KATAGO_SGF_PATH");
        const kataExePath = requireEnv("KATAGO_EXE");
        const kataModelPath = requireEnv("KATAGO_MODEL_PATH");
        const kataConfigPath = requireEnv("KATAGO_CONFIG_PATH");
        const { moveNumber, timeoutMs = 15000, topN = 3 } = args;
        if (!fs.existsSync(sgfPathFromEnv)) {
            throw new Error(`SGF ファイルが見つかりません: ${sgfPathFromEnv}`);
        }
        const sgfText = fs.readFileSync(sgfPathFromEnv, "utf8");
        const parsed = parseSgfFromText(sgfText);
        // 画像生成と保存（HC ディレクトリ配下）
        const { stones, last } = buildPosition(parsed, moveNumber);
        const svg = renderBoardSVG(parsed.size, stones, { last });
        const outDir = getSessionDir();
        const baseName = `move_${String(moveNumber).padStart(4, "0")}`;
        const imagePath = path.join(outDir, `${baseName}.svg`);
        try {
            saveSvg(imagePath, svg);
        }
        catch (e) { /* noop */ }
        const candMap = new Map();
        const kata = spawn(kataExePath, ["gtp", "-model", kataModelPath, "-config", kataConfigPath], {
            cwd: path.dirname(kataExePath),
            windowsHide: true,
        });
        let analyzing = false;
        const infoHandler = (text) => {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                if (!/^info\b/.test(line))
                    continue;
                const moveM = line.match(/\bmove\s+([A-Ta-t][0-9]+|pass|resign)\b/);
                if (!moveM)
                    continue;
                const move = moveM[1].toUpperCase();
                const visitsM = line.match(/\bvisits\s+(\d+)/i);
                const winM = line.match(/\bwinrate\s+([0-9]*\.?[0-9]+)/i);
                const scoreM = line.match(/\bscoreLead\s+(-?[0-9]*\.?[0-9]+)/i);
                const pvM = line.match(/\bpv\s+(.+)$/i);
                let wr;
                if (winM) {
                    const v = Number(winM[1]);
                    if (Number.isFinite(v))
                        wr = v <= 1 ? v * 100 : v;
                }
                const prev = candMap.get(move) || { move };
                candMap.set(move, {
                    move,
                    visits: visitsM ? Number(visitsM[1]) : prev.visits,
                    winrate: wr !== undefined ? wr : prev.winrate,
                    scoreLead: scoreM ? Number(scoreM[1]) : prev.scoreLead,
                    pv: pvM ? pvM[1].trim() : prev.pv,
                });
            }
        };
        kata.stdout.on("data", (buf) => { if (analyzing)
            infoHandler(buf.toString()); });
        kata.stderr.on("data", (buf) => { if (analyzing)
            infoHandler(buf.toString()); });
        function send(cmd) {
            try {
                kata.stdin.write(cmd + "\n");
            }
            catch { }
        }
        // 起動安定のため少し待機
        await new Promise(r => setTimeout(r, 800));
        // 盤面初期化と設定（server.ts はここまで実装済のため、同等処理を記述）
        send(`boardsize ${parsed.size}`);
        send(`komi ${parsed.komi}`);
        send("clear_board");
        // 置き石
        for (const p of parsed.ab)
            send(`play b ${sgfToGtpCoord(p, parsed.size)}`);
        for (const p of parsed.aw)
            send(`play w ${sgfToGtpCoord(p, parsed.size)}`);
        // 指定手数まで主変化を再現
        const upto = Math.max(0, Math.min(moveNumber, parsed.moves.length));
        for (let i = 0; i < upto; i++) {
            const mv = parsed.moves[i];
            send(`play ${mv.color} ${sgfToGtpCoord(mv.sgf, parsed.size)}`);
        }
        // 手番判定
        const totalPlays = parsed.ab.length + parsed.aw.length + upto;
        const sideToMove = totalPlays % 2 === 0 ? "b" : "w";
        // 解析開始
        analyzing = true;
        send("kata-analyze 1000");
        await new Promise(r => setTimeout(r, timeoutMs));
        analyzing = false;
        send("stop");
        // 集計
        const cands = Array.from(candMap.values());
        cands.sort((a, b) => (b.visits ?? -1) - (a.visits ?? -1) || (b.winrate ?? -1) - (a.winrate ?? -1));
        const top = cands.slice(0, topN);
        const best = top[0];
        let blackWinPct;
        let whiteWinPct;
        if (best?.winrate !== undefined && Number.isFinite(best.winrate)) {
            if (sideToMove === "b") {
                blackWinPct = best.winrate;
                whiteWinPct = 100 - best.winrate;
            }
            else {
                whiteWinPct = best.winrate;
                blackWinPct = 100 - best.winrate;
            }
        }
        const sideLabel = sideToMove === "b" ? "黒番" : "白番";
        const summary = best
            ? `手番: ${sideLabel} / 第1候補: ${best.move} / 勝率(手番側): ${best.winrate?.toFixed(1) ?? "-"}%`
            : "解析情報を取得できませんでした";
        // 終了
        try {
            send("quit");
        }
        catch { }
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
server.start({
    transportType: "stdio",
});
//# sourceMappingURL=server.js.map