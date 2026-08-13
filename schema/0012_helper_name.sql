-- The name the speaker typed for their helper, kept on the relationship rather
-- than read back off the person row. Rendering the person's stored name would
-- turn "add a helper by email" into an oracle: an existing account's real name
-- coming back would confirm the address is registered and to whom. So the list
-- shows what the speaker wrote, and nothing about who else that email may be.
ALTER TABLE speaker_helper ADD COLUMN helper_name TEXT;
