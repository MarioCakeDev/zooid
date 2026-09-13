/**
 * A mention the room can see. `m.mentions` routes; the leading MXID is what
 * renders — the client pills a bare MXID in plain text, and `stripMention`
 * removes it again before the agent's prompt. No HTML: see [[ZOD081]] §Design 3
 * for why an anchor renders worse here and would put an escaping burden on
 * interpolated webhook text.
 */
export function buildMentionContent(input: {
  userId: string
  text: string
  msgtype: string
}): { msgtype: string; body: string; [k: string]: unknown } {
  return {
    msgtype: input.msgtype,
    body: `${input.userId} ${input.text}`.trim(),
    'm.mentions': { user_ids: [input.userId] },
  }
}
