import type { Ad } from "./types"

// Server ad copy is untrusted at the render boundary: every C0 control byte (incl.
// ESC, tab, newline) and DEL is stripped so it can never emit escape sequences or
// break the VS Code status bar / tooltip when rendered.
const CONTROL = /[\u0000-\u001f\u007f]/g

// sanitize strips control bytes and trims whitespace from untrusted server copy
// before it is ever cached or rendered.
export function sanitize(s: string): string {
  return s.replace(CONTROL, "").trim()
}

// renderLine formats an ad as a single plain-text line. The advertiser domain leads
// the line, followed by the sentence ("<domain> - <sentence>"); when the sentence
// already contains the domain it is rendered as-is.
export function renderLine(ad: Ad): string {
  const sentence = sanitize(ad.sentence)
  const domain = sanitize(ad.domain)
  if (domain && !sentence.includes(domain)) {
    return `${domain} - ${sentence}`.trim()
  }
  return sentence
}

// adUrl builds a safe external URL for an ad's domain. A bare domain gets an https
// scheme; an explicit scheme is only honored when it is http(s), so a malformed or
// non-web value (e.g. a `file:`/`javascript:` scheme) can never be opened. Returns
// null when unsafe.
export function adUrl(domain: string): string | null {
  const d = sanitize(domain)
  if (!d) return null
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(d)
  if (scheme && scheme[1].toLowerCase() !== "http" && scheme[1].toLowerCase() !== "https") {
    return null
  }
  const candidate = scheme ? d : `https://${d}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  return url.toString()
}

// clickUrl resolves the click target for an ad: the advertiser's full destination
// URL (path + query such as UTM tags preserved) when it is a safe http(s) link, else
// the bare domain promoted to https. Returns null when neither is a safe http(s)
// target. The visible line always shows only the domain, never this URL.
export function clickUrl(ad: Ad): string | null {
  return adUrl(ad.website_url ?? "") ?? adUrl(ad.domain)
}

// adMarkdown renders a served ad for the chat participant: the advertiser's domain leads
// as an underlined, clickable Markdown link (Markdown link text is underlined by VS
// Code's chat renderer), followed by the bold sentence. The link's target is the
// advertiser's full destination URL (clickUrl) while the shown text is only the domain;
// the domain is only linked when a safe http(s) URL resolves, otherwise it is shown as
// plain text.
export function adMarkdown(ad: Ad): string {
  const sentence = sanitize(ad.sentence)
  const domain = sanitize(ad.domain)
  const url = clickUrl(ad)
  const link = domain ? (url ? `[${domain}](${url})` : domain) : ""
  const stripped =
    sentence.includes(domain) && domain ? sentence.replace(domain, "").trim() : sentence
  // Drop any leftover separator now that the domain leads the line.
  const body = stripped.replace(/^[-\s]+|[-\s]+$/g, "")
  const bold = body ? `**${body}**` : ""
  return ["**Sponsored:**", link, bold].filter(Boolean).join(" ")
}
