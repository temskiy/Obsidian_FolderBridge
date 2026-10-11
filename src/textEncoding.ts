/**
 * Decoding of text files on local mounts.
 *
 * Obsidian edits notes as UTF-8. Notes on shared drives are sometimes stored
 * in an older encoding instead: Windows-1252 ("ANSI") from older Windows
 * tools, or UTF-16 with a byte-order mark. Reading those as UTF-8 turns
 * characters such as £ € é into U+FFFD, and saving that text back would
 * replace the original bytes for good. So such files are decoded with their
 * real encoding (readable in Obsidian) and flagged, and saving them is refused.
 */

export interface DecodedText {
	text: string;
	/** Not valid UTF-8: decoded for reading, but a UTF-8 save would change its characters. */
	nonUtf8: boolean;
}

// ignoreBOM keeps a UTF-8 byte-order mark in the text, exactly like
// readFile(…, 'utf8') did, so writing the text back preserves it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const windows1252Controls = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,
	0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
	0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
	0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

export function decodeText(buf: Uint8Array): DecodedText {
	if (buf[0] === 0xff && buf[1] === 0xfe) {
		return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), nonUtf8: true };
	}
	if (buf[0] === 0xfe && buf[1] === 0xff) {
		return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), nonUtf8: true };
	}
	try {
		return { text: utf8.decode(buf), nonUtf8: false };
	} catch {
		// Not UTF-8: on a Windows share almost always Windows-1252.
		// Some Node/ICU builds decode the CP1252 control range as Latin-1.
		let text = '';
		for (const byte of buf) {
			text += String.fromCodePoint(byte >= 0x80 && byte <= 0x9f ? windows1252Controls[byte - 0x80] : byte);
		}
		return { text, nonUtf8: true };
	}
}
