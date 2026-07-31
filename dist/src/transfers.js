import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { STORE_DIR } from "../storage.js";
import { HermesError } from "./errors.js";
import { redactSensitiveText } from "./redaction.js";
function transferError(reason, nextStep) {
    return new HermesError("TRANSFER_PATH_DENIED", reason, false, nextStep);
}
function hasWindowsDeviceSyntax(value) {
    const normalized = value.replaceAll("/", "\\");
    if (/^(?:\\\\[.?]\\|\\[.?]\\)/.test(normalized))
        return true;
    if (/^[A-Za-z]:(?!\\)/.test(normalized))
        return true;
    const withoutDrive = normalized.replace(/^[A-Za-z]:/, "");
    if (withoutDrive.includes(":"))
        return true;
    return normalized.split("\\").some((segment) => {
        if (/[ .]$/.test(segment))
            return true;
        const stem = segment.split(".")[0]?.replace(/[ .]+$/g, "").toUpperCase();
        return /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(stem ?? "");
    });
}
function configuredRoots(direction) {
    const name = direction === "export"
        ? "HERMES_TRANSFER_EXPORT_ROOTS"
        : "HERMES_TRANSFER_IMPORT_ROOTS";
    return (process.env[name] ?? "")
        .split(delimiter)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => resolve(item));
}
function isContained(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function existing(value) {
    return stat(value).then(() => true, () => false);
}
async function canonicalCandidate(candidate, candidateExists) {
    if (candidateExists)
        return realpath(candidate);
    let parent = dirname(candidate);
    const suffix = [];
    while (!(await existing(parent))) {
        const next = dirname(parent);
        if (next === parent)
            throw transferError("Transfer parent does not exist inside an allowed root.", "Create the parent directory under the configured transfer root first.");
        suffix.unshift(relative(next, parent));
        parent = next;
    }
    const canonicalParent = await realpath(parent);
    return resolve(canonicalParent, ...suffix, relative(dirname(candidate), candidate));
}
export async function resolveTransferTarget(request) {
    const defaultRoot = join(STORE_DIR, "transfers", request.direction === "export" ? "exports" : "imports");
    await mkdir(defaultRoot, { recursive: true, mode: 0o700 });
    const requested = request.requested?.trim()
        || (request.direction === "export" ? `hermes-${Date.now()}-${randomUUID()}.json` : "");
    if (!requested)
        throw transferError("An import file name is required.", "Place a JSON file in transfers/imports and pass its relative file name.");
    if (requested.includes("\0") || hasWindowsDeviceSyntax(requested)) {
        throw transferError("Device paths and alternate data streams are not valid transfer targets.", "Use a normal .json file under an allowed transfer root.");
    }
    if (request.direction === "import" && extname(requested).toLowerCase() !== ".json") {
        throw transferError("Imports must use a .json file.", "Choose a JSON export under transfers/imports.");
    }
    const roots = [defaultRoot, ...configuredRoots(request.direction)];
    const canonicalRoots = [];
    for (const root of roots) {
        await mkdir(root, { recursive: true, mode: 0o700 });
        canonicalRoots.push(await realpath(root));
    }
    const lexicalCandidate = isAbsolute(requested) ? resolve(requested) : resolve(defaultRoot, requested);
    const candidateExists = await existing(lexicalCandidate);
    const canonical = await canonicalCandidate(lexicalCandidate, candidateExists);
    const rootIndex = canonicalRoots.findIndex((root) => isContained(root, canonical));
    if (rootIndex < 0) {
        throw transferError("Transfer path is outside an allowed root.", "Choose a file under the configured transfer directory.");
    }
    const root = canonicalRoots[rootIndex];
    if (request.direction === "import" && !candidateExists) {
        throw transferError("Import file does not exist.", "Place the JSON file under transfers/imports before importing it.");
    }
    if (request.direction === "export" && candidateExists && !request.overwrite) {
        throw transferError("Target exists and overwrite was not confirmed.", "Pass overwrite:true or choose a new file name.");
    }
    if (candidateExists) {
        const info = await stat(canonical);
        if (!info.isFile())
            throw transferError("Transfer target is not a regular file.", "Choose a regular .json file.");
    }
    return { absolute: canonical, relative: relative(root, canonical), exists: candidateExists, root };
}
export function redactExportValue(value) {
    if (typeof value === "string")
        return redactSensitiveText(value, { strictHistorical: true });
    if (Array.isArray(value))
        return value.map(redactExportValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactExportValue(child)]));
    }
    return value;
}
export async function writeTransferJson(target, value, counts, redacted) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    const temporary = join(dirname(target.absolute), `.${randomUUID()}.tmp`);
    try {
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(serialized, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        if (target.exists) {
            await rename(temporary, target.absolute);
        }
        else {
            try {
                await link(temporary, target.absolute);
            }
            catch (error) {
                const code = error && typeof error === "object" && "code" in error
                    ? String(error.code)
                    : "";
                if (code === "EEXIST") {
                    throw transferError("Target appeared before commit.", "Retry with overwrite:true or choose a new name.");
                }
                throw error;
            }
            await rm(temporary, { force: true });
        }
    }
    finally {
        await rm(temporary, { force: true }).catch(() => { });
    }
    return { file: target.relative, bytes, sha256, counts, redacted };
}
