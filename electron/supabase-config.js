'use strict';

/**
 * Public project identifiers only — safe to ship inside the installer.
 *
 * This key identifies *which* Supabase project to talk to; Row Level
 * Security policies on every table and storage bucket decide *who* is
 * allowed to do what. Someone unpacking the installer and finding this key
 * can only do what any authenticated (or anonymous) user is allowed to do
 * through those policies — read/write their own rows, read other people's
 * public rows.
 *
 * NEVER put a service_role key here, or anywhere in this app. It bypasses
 * Row Level Security entirely, and there is no server-side component to
 * keep it in — this app has no legitimate use for one.
 *
 * Fill these in from Project Settings -> API in the Supabase dashboard.
 */
module.exports = {
  SUPABASE_URL: 'https://njxypnkamladkjtxging.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qeHlwbmthbWxhZGtqdHhnaW5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MTg0NzAsImV4cCI6MjEwMjk5NDQ3MH0.YQzk5IjMTKvujohGkzmJCS1p4lv1IkFX8m5_FurbTE0',
};
