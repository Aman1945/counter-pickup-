-- Runs once when the Postgres volume is first created: a separate database for the test suite,
-- so running the tests never touches the app's data.
CREATE DATABASE pickup_test OWNER pickup;
