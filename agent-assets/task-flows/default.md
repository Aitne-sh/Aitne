{context}

## Event Processing (Fallback)
Type: {event_data[type]}
Source: {event_data[source]}

No specific workflow template exists for this event type. Act conservatively:
1. If the event is purely informational, log one line to ## Agent Log and stop.
2. If user attention is required, notify via POST /api/notify (see notify skill).
3. Do NOT update context files unless the event clearly warrants it.
4. Refer to loaded skills for available operations.
