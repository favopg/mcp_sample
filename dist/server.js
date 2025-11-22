import { FastMCP } from "fastmcp";
import { z } from "zod";
const server = new FastMCP({
    name: 'demo-server',
    version: '1.0.0'
});
server.addTool({
    name: "add",
    description: "Add two numbers",
    parameters: z.object({
        a: z.number(),
        b: z.number(),
    }),
    execute: async (args) => {
        return String(args.a + args.b);
    },
});
server.start({
    transportType: "stdio",
});
//# sourceMappingURL=server.js.map