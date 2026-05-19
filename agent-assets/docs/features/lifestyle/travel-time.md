---
schema_version: 1
slug: features/lifestyle/travel-time
title: Travel Time
id: travel-time
aliases:
  - door to door
  - eta
category: features
summary: |
  A skill that estimates door-to-door travel time given an origin
  and destination — used by schedule-approaching reminders for
  events with location.
section: lifestyle
tags:
  - lifestyle
  - travel
  - skills
status: stable
ask_examples:
  - How long will it take me to get to the airport?
  - Does the agent know about traffic?
locale: en-US
created: 2026-04-25
updated: 2026-04-25
keywords:
  - travel time
  - departure time
  - google maps
  - commute
  - ETA
related:
  - features/lifestyle/travel-bookings
  - features/operations/schedule-approaching
---

# Travel Time

## In One Sentence

A skill the agent calls to estimate door-to-door travel time before
a calendar event with a location.

## What It Does

- Reads origin (current location, configured home/work) and
  destination (event location).
- Returns a typical-time estimate with mode (drive, transit, walk).
- Used by `schedule-approaching` reminders to lead-time the alert.

## Where in the Dashboard

There is no operator surface for the travel-time data itself; the
estimates appear inline in event reminders and morning routines.

## Related

- [Schedule Approaching](../operations/schedule-approaching.md)
