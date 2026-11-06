-- Redline 1.2.1: size caps on tester feedback, matching the feedback route's limits.
--
-- Feedback is untrusted input from anyone the host lets in, so the table bounds every
-- free-text column even if a route forgets to.
--
-- Rows saved before this migration can be longer. A check constraint applies to every
-- later UPDATE of a row, including a status change, so an oversized old row would
-- become impossible to triage. They are cut to the caps first. The trims leave status
-- alone, so stamp_status doesn't fire. stamp_approval runs on every update but only acts
-- on 'review' rows (already unapproved) and on 'open' rows without approved_at, which
-- the redline_triage backfill and the insert trigger leave none of.

update feedback.items set feedback = left(feedback, 5000) where char_length(feedback) > 5000;
update feedback.items set element_text = left(element_text, 2000) where char_length(element_text) > 2000;
update feedback.items set element_selector = left(element_selector, 1000) where char_length(element_selector) > 1000;
update feedback.items set page_url = left(page_url, 2000) where char_length(page_url) > 2000;
update feedback.items set user_agent = left(user_agent, 512) where char_length(user_agent) > 512;

alter table feedback.items
  add constraint items_feedback_len check (char_length(feedback) <= 5000),
  add constraint items_element_text_len check (element_text is null or char_length(element_text) <= 2000),
  add constraint items_element_selector_len check (char_length(element_selector) <= 1000),
  add constraint items_page_url_len check (char_length(page_url) <= 2000),
  add constraint items_user_agent_len check (user_agent is null or char_length(user_agent) <= 512);

-- Screenshots: the route rejects anything over 8 MB, so the bucket does too.
update storage.buckets
set file_size_limit = 8388608
where id = 'redline-screenshots' and (file_size_limit is null or file_size_limit > 8388608);
