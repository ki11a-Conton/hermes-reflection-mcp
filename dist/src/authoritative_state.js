import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
export class AuthoritativeStateError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AuthoritativeStateError";
    }
}
function errorCode(error) {
    return error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
}
export async function readAuthoritativeUtf8(path) {
    try {
        return { exists: true, raw: await readFile(path, "utf8") };
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return { exists: false };
        throw new AuthoritativeStateError(`Refusing to continue: existing state file ${basename(path)} could not be read. Nothing was changed.`, { cause: error });
    }
}
export async function preserveCorruptUtf8(path, raw) {
    const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
    const backup = `${path}.corrupt.${digest}.bak`;
    try {
        await writeFile(backup, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    catch (error) {
        if (errorCode(error) !== "EEXIST") {
            throw new AuthoritativeStateError(`Refusing to continue: corrupt state evidence for ${basename(path)} could not be preserved. Nothing was changed.`, { cause: error });
        }
    }
    return basename(backup);
}
export async function readAuthoritativeJson(path, label) {
    const read = await readAuthoritativeUtf8(path);
    if (!read.exists)
        return read;
    try {
        return { exists: true, raw: read.raw, value: JSON.parse(read.raw) };
    }
    catch (error) {
        const backup = await preserveCorruptUtf8(path, read.raw);
        throw new AuthoritativeStateError(`Refusing to continue: ${label} ${basename(path)} cannot be parsed. Evidence backup: ${backup}. Nothing was changed.`, { cause: error });
    }
}
