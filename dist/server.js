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
        timeoutMs: z.number().int().min(1000).max(120000).optional().default(15000),
        topN: z.number().int().min(1).max(10).optional().default(3),
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
        });
    }
});
server.start({
    transportType: "stdio",
});
//# sourceMappingURL=server.js.map