import { FastMCP } from "fastmcp";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
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
server.addTool({
    name: "katago_replay",
    description: "Start KataGo (GTP), set up board from sgf/test.sgf via play commands, then quit. Returns startup and replay logs.",
    parameters: z.object({}),
    execute: async () => {
        // SGF 読み込み（ESM 環境で __dirname が未定義になる場合があるため、process.cwd() を基準に解決）
        //const sgfPath = path.resolve(process.cwd(), "sgf", "test.sgf");
        const sgfPath = "C:\\Users\\favor\\typescript_katago\\sgf\\test.sgf";
        if (!fs.existsSync(sgfPath)) {
            return JSON.stringify({ ok: false, error: `SGF ファイルが見つかりません: ${sgfPath}` });
        }
        const sgfText = fs.readFileSync(sgfPath, "utf8");
        const parsed = parseSgfFromText(sgfText);
        const totalMoves = parsed.moves.length;
        // KataGo 起動（index.ts と同じ固定パス。必要なら後で .env 化）
        const kataExe = "C:\\Users\\favor\\katago\\katago.exe";
        const modelPath = "C:\\Users\\favor\\katago\\kata1-b28c512nbt-adam-s11165M-d5387M.bin.gz";
        const configPath = "C:\\Users\\favor\\katago\\default_gtp.cfg";
        const args = ["gtp", "-model", modelPath, "-config", configPath];
        const kata = spawn(kataExe, args, { cwd: path.dirname(kataExe), windowsHide: true });
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
server.start({
    transportType: "stdio",
});
//# sourceMappingURL=server.js.map