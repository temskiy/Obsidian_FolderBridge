type LoggerLevel = 'debug' | 'warn' | 'error';

const LOG_PREFIX = '[FolderBridge]';

function normalizeArgs(args: unknown[]): unknown[] {
    if (args.length === 0) {
        return [LOG_PREFIX];
    }

    const [first, ...rest] = args;
    if (typeof first === 'string') {
        if (first.startsWith('[FolderBridge]') || first.startsWith('[Folder Bridge]')) {
            return args;
        }
        return [`${LOG_PREFIX} ${first}`, ...rest];
    }

    return [LOG_PREFIX, ...args];
}

function write(level: LoggerLevel, ...args: unknown[]): void {
    const logger = globalThis.console;
    const method = logger?.[level] ?? logger?.log;
    method?.(...normalizeArgs(args));
}

export const logger = {
    debug: (...args: unknown[]) => {
        if ((globalThis as Record<string, unknown>).__folderbridgeDebugLogging) {
            write('debug', ...args);
        }
    },
    warn: (...args: unknown[]) => write('warn', ...args),
    error: (...args: unknown[]) => write('error', ...args),
};

/** Toggle debug logging at runtime. */
export function setDebugLogging(enabled: boolean): void {
    (globalThis as Record<string, unknown>).__folderbridgeDebugLogging = enabled;
}
