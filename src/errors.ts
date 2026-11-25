export class HarnessError extends Error {
	readonly code: string;
	readonly hint?: string | undefined;

	constructor(code: string, message: string, hint?: string) {
		super(message);
		this.name = "HarnessError";
		this.code = code;
		this.hint = hint;
	}
}

export function asHarnessError(error: unknown): HarnessError {
	if (error instanceof HarnessError) return error;
	if (error instanceof Error) return new HarnessError("unknown", error.message);
	return new HarnessError("unknown", String(error));
}
