import { widget } from "../src/utils/widget.js";

// A real, passing unit test of the wildcard-exported public util. It must NOT
// be flagged a zombie: `widget` is production-alive (public via the wildcard),
// so this test exercises production-alive code.
if (widget() !== 42) throw new Error("unexpected");
