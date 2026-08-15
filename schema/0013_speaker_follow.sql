-- 0013: following a speaker (AIE++ seed).
--
-- A follow is GLOBAL to the person, not scoped to one conference: you follow
-- the speaker, and the point of the feature is that when they turn up at
-- ANOTHER conference you hear about it (step 3, organizer-gated). So the
-- uniqueness is the person pair, and origin_event_id only records where the
-- follow was made — the place the follower discovered them.
--
-- It is the follower's own private list. Nothing here is exposed to the
-- speaker or to anyone else; there is no public follower count or list. Soft
-- delete (unfollowed_at) so a re-follow is idempotent, the same discipline
-- friend_request and speaker_helper keep.
CREATE TABLE speaker_follow (
  id                 TEXT PRIMARY KEY,
  follower_person_id TEXT NOT NULL REFERENCES person(id),
  speaker_person_id  TEXT NOT NULL REFERENCES person(id),
  origin_event_id    TEXT NOT NULL REFERENCES event(id),
  created_at         INTEGER NOT NULL,
  unfollowed_at      INTEGER,
  UNIQUE (follower_person_id, speaker_person_id),
  CHECK (follower_person_id <> speaker_person_id)
);
CREATE INDEX idx_speaker_follow_follower
  ON speaker_follow(follower_person_id) WHERE unfollowed_at IS NULL;
CREATE INDEX idx_speaker_follow_speaker
  ON speaker_follow(speaker_person_id) WHERE unfollowed_at IS NULL;
