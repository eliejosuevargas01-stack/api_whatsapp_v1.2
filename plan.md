1. **Remove Channel (Newsletter) Processing**
   - The user requested to "eliminate channels" and not receive them. Channels in WhatsApp are referred to as `newsletter` JIDs (ending with `@newsletter`).
   - We need to modify `normalizeIncomingMessage` or `handleMessagesUpsert` to completely drop (ignore) any messages coming from a `@newsletter`.
   - Ensure the UI or API doesn't list them, though dropping them at ingestion is the safest way to ensure they aren't processed or displayed.
2. **Review Code for Any Other Newsletter Ingestion**
   - Check `importHistorySync` to skip `chat.id.endsWith('@newsletter')`.
   - Update `getConversationKind` if necessary, although if we drop them early they might never reach it.
3. **Execute Pre-commit & Submit**
   - Verify everything compiles and works as expected.
