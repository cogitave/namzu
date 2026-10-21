/**
 * Every failure of a native request, sidecar-reported or client-side.
 *
 * Sidecar codes: `bad_request`, `request_too_large`, `unknown_op`,
 * `invalid_params`, `file_error`, `not_regular_file`, `too_large`,
 * `unsupported_format`, `parse_error`, `no_embedded_payload`,
 * `extract_refused`, `out_dir_invalid`, `io_error`, `deadline_exceeded`,
 * `output_too_large`, `internal`.
 *
 * Client codes: `sidecar_not_found`, `sidecar_exited`, `response_too_large`,
 * `protocol_error`, `closed`. `deadline_exceeded` is used by both: the sidecar
 * reports it when it stops cooperatively, the client when it had to kill.
 */
export class NativeAnalysisError extends Error {
	override readonly name = 'NativeAnalysisError'

	constructor(
		readonly code: string,
		message: string,
		readonly op?: string,
	) {
		super(message)
	}
}
