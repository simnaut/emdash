/**
 * Content format detection for PDS records.
 *
 * Detects whether a PDS record was created by EmDash, Leaflet,
 * WhiteWind, or a plain standard.site client.
 */

export type ContentOrigin = "emdash" | "leaflet" | "whitewind" | "standard-site" | "unknown";

export interface DetectedFormat {
	origin: ContentOrigin;
	/** The collection NSID the record came from */
	collection: string;
}

/**
 * Detect the origin/format of a PDS record value.
 *
 * @param value - The record's `value` from listRecords/getRecord
 * @param collection - The PDS collection NSID it was found in
 */
export function detectFormat(value: unknown, collection: string): DetectedFormat {
	if (collection === "com.whtwnd.blog.entry") {
		return { origin: "whitewind", collection };
	}

	if (!value || typeof value !== "object") {
		return { origin: "unknown", collection };
	}

	const record = value as Record<string, unknown>;

	// Check for EmDash content in the open union
	if (record.content && typeof record.content === "object") {
		const content = record.content as Record<string, unknown>;
		if (content.$type === "cms.emdash.portableText") {
			return { origin: "emdash", collection };
		}
		if (
			content.$type === "pub.leaflet.content" ||
			(typeof content.$type === "string" && content.$type.startsWith("pub.leaflet."))
		) {
			return { origin: "leaflet", collection };
		}
	}

	// If it's a site.standard.document without a recognized content type
	if (record.$type === "site.standard.document") {
		return { origin: "standard-site", collection };
	}

	return { origin: "unknown", collection };
}
