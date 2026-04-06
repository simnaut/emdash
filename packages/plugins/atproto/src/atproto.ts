/**
 * AT Protocol client helpers
 *
 * Handles session management, record CRUD, and handle resolution.
 * All HTTP goes through ctx.http.fetch() for sandbox compatibility.
 */

import type { PluginContext } from "emdash";

// ── Types ───────────────────────────────────────────────────────

export interface AtSession {
	accessJwt: string;
	refreshJwt: string;
	did: string;
	handle: string;
}

export interface AtRecord {
	uri: string;
	cid: string;
}

export interface BlobRef {
	$type: "blob";
	ref: { $link: string };
	mimeType: string;
	size: number;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Get the HTTP client from plugin context, or throw a helpful error. */
export function requireHttp(ctx: PluginContext) {
	if (!ctx.http) {
		throw new Error("AT Protocol plugin requires the network:fetch capability");
	}
	return ctx.http;
}

/** Validate that a PDS response contains expected string fields. */
function requireString(data: Record<string, unknown>, field: string, context: string): string {
	const value = data[field];
	if (typeof value !== "string") {
		throw new Error(`${context}: missing or invalid '${field}' in response`);
	}
	return value;
}

// ── Session management ──────────────────────────────────────────

/**
 * Create a new session with the PDS using an app password.
 */
export async function createSession(
	ctx: PluginContext,
	pdsHost: string,
	identifier: string,
	password: string,
): Promise<AtSession> {
	const http = requireHttp(ctx);
	const res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.server.createSession`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identifier, password }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`createSession failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		accessJwt: requireString(data, "accessJwt", "createSession"),
		refreshJwt: requireString(data, "refreshJwt", "createSession"),
		did: requireString(data, "did", "createSession"),
		handle: requireString(data, "handle", "createSession"),
	};
}

/**
 * Refresh an existing session using the refresh token.
 */
export async function refreshSession(
	ctx: PluginContext,
	pdsHost: string,
	refreshJwt: string,
): Promise<AtSession> {
	const http = requireHttp(ctx);
	const res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.server.refreshSession`, {
		method: "POST",
		headers: { Authorization: `Bearer ${refreshJwt}` },
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`refreshSession failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		accessJwt: requireString(data, "accessJwt", "refreshSession"),
		refreshJwt: requireString(data, "refreshJwt", "refreshSession"),
		did: requireString(data, "did", "refreshSession"),
		handle: requireString(data, "handle", "refreshSession"),
	};
}

/**
 * In-flight refresh promise for deduplication.
 * Prevents concurrent publishes from racing on token refresh,
 * which would corrupt tokens since PDS invalidates refresh tokens after use.
 */
let refreshInFlight: Promise<AtSession> | null = null;

/**
 * Get a valid access token, refreshing if needed.
 * Uses promise deduplication to prevent concurrent refresh races.
 */
export async function ensureSession(ctx: PluginContext): Promise<{
	accessJwt: string;
	did: string;
	pdsHost: string;
}> {
	const pdsHost = (await ctx.kv.get<string>("settings:pdsHost")) || "bsky.social";
	const handle = await ctx.kv.get<string>("settings:handle");
	const appPassword = await ctx.kv.get<string>("settings:appPassword");

	if (!handle || !appPassword) {
		throw new Error("AT Protocol credentials not configured");
	}

	// Try existing tokens first
	const existingAccess = await ctx.kv.get<string>("state:accessJwt");
	const existingRefresh = await ctx.kv.get<string>("state:refreshJwt");
	const existingDid = await ctx.kv.get<string>("state:did");

	if (existingAccess && existingDid) {
		return { accessJwt: existingAccess, did: existingDid, pdsHost };
	}

	// Try refresh if we have a refresh token (deduplicated)
	if (existingRefresh) {
		if (!refreshInFlight) {
			refreshInFlight = refreshSession(ctx, pdsHost, existingRefresh)
				.then(async (session) => {
					await persistSession(ctx, session);
					return session;
				})
				.finally(() => {
					refreshInFlight = null;
				});
		}
		try {
			const session = await refreshInFlight;
			return { accessJwt: session.accessJwt, did: session.did, pdsHost };
		} catch {
			// Refresh failed, fall through to full login
		}
	}

	// Full login
	const session = await createSession(ctx, pdsHost, handle, appPassword);
	await persistSession(ctx, session);
	return { accessJwt: session.accessJwt, did: session.did, pdsHost };
}

async function persistSession(ctx: PluginContext, session: AtSession): Promise<void> {
	await ctx.kv.set("state:accessJwt", session.accessJwt);
	await ctx.kv.set("state:refreshJwt", session.refreshJwt);
	await ctx.kv.set("state:did", session.did);
}

// ── Record CRUD ─────────────────────────────────────────────────

/**
 * Create a record on the PDS. Returns the AT-URI and CID.
 * Retries once on 401 (expired token) by refreshing the session.
 */
export async function createRecord(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	collection: string,
	record: unknown,
): Promise<AtRecord> {
	const http = requireHttp(ctx);
	let res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.createRecord`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ repo: did, collection, record }),
	});

	// Retry once on 401 with refreshed token
	if (res.status === 401) {
		const refreshed = await ensureSessionFresh(ctx, pdsHost);
		if (refreshed) {
			res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.createRecord`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${refreshed.accessJwt}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ repo: refreshed.did, collection, record }),
			});
		}
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`createRecord failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		uri: requireString(data, "uri", "createRecord"),
		cid: requireString(data, "cid", "createRecord"),
	};
}

/**
 * Update (upsert) a record on the PDS.
 * Retries once on 401 (expired token).
 */
export async function putRecord(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	collection: string,
	rkey: string,
	record: unknown,
): Promise<AtRecord> {
	const http = requireHttp(ctx);
	let res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.putRecord`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ repo: did, collection, rkey, record }),
	});

	if (res.status === 401) {
		const refreshed = await ensureSessionFresh(ctx, pdsHost);
		if (refreshed) {
			res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.putRecord`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${refreshed.accessJwt}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ repo: refreshed.did, collection, rkey, record }),
			});
		}
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`putRecord failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		uri: requireString(data, "uri", "putRecord"),
		cid: requireString(data, "cid", "putRecord"),
	};
}

/**
 * Delete a record from the PDS.
 * Retries once on 401 (expired token).
 */
export async function deleteRecord(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	collection: string,
	rkey: string,
): Promise<void> {
	const http = requireHttp(ctx);
	let res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.deleteRecord`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ repo: did, collection, rkey }),
	});

	if (res.status === 401) {
		const refreshed = await ensureSessionFresh(ctx, pdsHost);
		if (refreshed) {
			res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.deleteRecord`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${refreshed.accessJwt}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ repo: refreshed.did, collection, rkey }),
			});
		}
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`deleteRecord failed (${res.status}): ${body}`);
	}
}

/**
 * Force a session refresh (for 401 retry). Clears the stale access token
 * and delegates to ensureSession, which handles refresh deduplication.
 * Returns null if refresh fails.
 */
async function ensureSessionFresh(
	ctx: PluginContext,
	_pdsHost: string,
): Promise<{ accessJwt: string; did: string } | null> {
	// Clear stale access token so ensureSession will attempt a refresh
	await ctx.kv.set("state:accessJwt", "");

	try {
		const result = await ensureSession(ctx);
		return { accessJwt: result.accessJwt, did: result.did };
	} catch {
		return null;
	}
}

// ── Handle resolution ───────────────────────────────────────────

/**
 * Resolve an AT Protocol handle to a DID.
 * Uses the public API -- no auth required.
 */
export async function resolveHandle(ctx: PluginContext, handle: string): Promise<string> {
	const http = requireHttp(ctx);
	const res = await http.fetch(
		`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
	);

	if (!res.ok) {
		throw new Error(`resolveHandle failed for ${handle} (${res.status})`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return requireString(data, "did", "resolveHandle");
}

// ── Blob upload ─────────────────────────────────────────────────

/**
 * Upload a blob (image) to the PDS. Returns a blob reference for embedding.
 */
export async function uploadBlob(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	imageBytes: ArrayBuffer,
	mimeType: string,
): Promise<BlobRef> {
	const http = requireHttp(ctx);
	const res = await http.fetch(`https://${pdsHost}/xrpc/com.atproto.repo.uploadBlob`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessJwt}`,
			"Content-Type": mimeType,
		},
		body: imageBytes,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`uploadBlob failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	if (!data.blob || typeof data.blob !== "object") {
		throw new Error("uploadBlob: missing 'blob' in response");
	}
	const blob = data.blob as Record<string, unknown>;
	if (!blob.ref || typeof blob.ref !== "object") {
		throw new Error("uploadBlob: malformed blob reference in response");
	}
	return data.blob as BlobRef;
}

// ── Record listing & retrieval ──────────────────────────────────

export interface ListRecordsResponse {
	records: Array<{ uri: string; cid: string; value: unknown }>;
	cursor?: string;
}

/**
 * List records in a collection on the PDS.
 * Supports cursor-based pagination.
 */
export async function listRecords(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	collection: string,
	opts?: { limit?: number; cursor?: string; reverse?: boolean },
): Promise<ListRecordsResponse> {
	const http = requireHttp(ctx);
	const params = new URLSearchParams({
		repo: did,
		collection,
	});
	if (opts?.limit) params.set("limit", String(opts.limit));
	if (opts?.cursor) params.set("cursor", opts.cursor);
	if (opts?.reverse) params.set("reverse", "true");

	let res = await http.fetch(
		`https://${pdsHost}/xrpc/com.atproto.repo.listRecords?${params.toString()}`,
		{
			headers: { Authorization: `Bearer ${accessJwt}` },
		},
	);

	if (res.status === 401) {
		const refreshed = await ensureSessionFresh(ctx, pdsHost);
		if (refreshed) {
			res = await http.fetch(
				`https://${pdsHost}/xrpc/com.atproto.repo.listRecords?${params.toString()}`,
				{
					headers: { Authorization: `Bearer ${refreshed.accessJwt}` },
				},
			);
		}
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`listRecords failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	const records = Array.isArray(data.records) ? data.records : [];
	const cursor = typeof data.cursor === "string" ? data.cursor : undefined;

	return {
		records: records as Array<{ uri: string; cid: string; value: unknown }>,
		cursor,
	};
}

/**
 * Get a single record from the PDS by rkey.
 */
export async function getRecord(
	ctx: PluginContext,
	pdsHost: string,
	accessJwt: string,
	did: string,
	collection: string,
	rkey: string,
): Promise<{ uri: string; cid: string; value: unknown }> {
	const http = requireHttp(ctx);
	const params = new URLSearchParams({ repo: did, collection, rkey });

	let res = await http.fetch(
		`https://${pdsHost}/xrpc/com.atproto.repo.getRecord?${params.toString()}`,
		{
			headers: { Authorization: `Bearer ${accessJwt}` },
		},
	);

	if (res.status === 401) {
		const refreshed = await ensureSessionFresh(ctx, pdsHost);
		if (refreshed) {
			res = await http.fetch(
				`https://${pdsHost}/xrpc/com.atproto.repo.getRecord?${params.toString()}`,
				{
					headers: { Authorization: `Bearer ${refreshed.accessJwt}` },
				},
			);
		}
	}

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`getRecord failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		uri: requireString(data, "uri", "getRecord"),
		cid: requireString(data, "cid", "getRecord"),
		value: data.value,
	};
}

// ── Utilities ───────────────────────────────────────────────────

/**
 * Extract the rkey from an AT-URI.
 * at://did:plc:xxx/collection/rkey -> rkey
 */
export function rkeyFromUri(uri: string): string {
	const parts = uri.split("/");
	const rkey = parts.at(-1);
	if (!rkey) {
		throw new Error(`Invalid AT-URI: ${uri}`);
	}
	return rkey;
}
