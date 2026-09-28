import { decodeHTMLStrict } from 'entities';
import { opaqueAt, readTag, tagExtent } from './opaque';

// Protocol forms reported by Chinese Wikipedia's siteinfo API. They remain inert metadata in the view.
const urlPattern = /^(?:(?:bitcoin|geo|magnet|mailto|matrix|news|sip|sips|sms|tel|urn|xmpp):|(?:ftp|ftps|git|gopher|http|https|irc|ircs|mms|nntp|redis|sftp|ssh|svn|telnet|wikipedia|worldwind):\/\/|\/\/)[^\s<>\[\]{}|]+/i;

export interface ExternalLink {
  end: number;
  href: string;
  urlFrom: number;
  urlTo: number;
  labelFrom: number;
  labelTo: number;
  numbered: boolean;
  bracketed: boolean;
}

export function externalLinkAt(source: string, from: number, baseUrl: string): ExternalLink | null {
  const bracketed = source[from] === '[';
  const urlFrom = from + (bracketed ? 1 : 0);
  const match = urlPattern.exec(source.slice(urlFrom));
  if (!match) return null;
  let value = match[0];
  if (!bracketed) {
    value = value.replace(/[.,;:!?"'。，；：！？、]+$/, '');
    while (value.endsWith(')') && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) value = value.slice(0, -1);
  }
  const urlTo = urlFrom + value.length;
  let href: string;
  try { href = new URL(decodeHTMLStrict(value), baseUrl).href; } catch { return null; }
  if (!bracketed) return { end: urlTo, href, urlFrom, urlTo, labelFrom: urlFrom, labelTo: urlTo, numbered: false, bracketed };
  let close = urlTo;
  while (close < source.length && source[close] !== ']') {
    const opaque = opaqueAt(source, close);
    const tag = source[close] === '<' ? readTag(source, close) : null;
    if (opaque) close = opaque.end;
    else if (tag) close = tagExtent(source, close, tag);
    else close++;
  }
  if (close >= source.length) return null;
  let labelFrom = urlTo, labelTo = close;
  while (labelFrom < close && /\s/.test(source[labelFrom])) labelFrom++;
  while (labelTo > labelFrom && /\s/.test(source[labelTo - 1])) labelTo--;
  return { end: close + 1, href, urlFrom, urlTo, labelFrom, labelTo, numbered: labelFrom === labelTo, bracketed };
}
