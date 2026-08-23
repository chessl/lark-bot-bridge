# Lark Bot Bridge

Vocabulary for requests entering the bridge, the conversations they belong to, and the agent replies they produce.

## Conversation boundaries

**Chat**:
A Lark conversation container, either private or group. A regular chat has one Conversation Scope; a topic group contains multiple Topics.
_Avoid_: Channel, room

**Topic**:
A threaded conversation inside a topic group. Each Topic is a separate Conversation Scope, even when several Topics belong to the same Chat.
_Avoid_: Chat, generic thread

**Conversation Scope**:
The conversation boundary within which agent context and in-flight work are shared. A private or regular group Chat is one scope; each Topic is its own scope.
_Avoid_: Chat when Topics are possible, Channel

**Session**:
The persistent agent conversation context that may be resumed across Runs within a Conversation Scope. A Session may be reset or replaced without changing its Conversation Scope.
_Avoid_: Conversation Scope, Run, Chat

## Inputs and work

**Invocation**:
A request for the bridge to act, originating from an instant message, card action, document comment, or meeting interaction.
_Avoid_: Event, webhook, Prompt

**Invocation Source**:
The Lark surface from which an Invocation originates: instant message, card, document comment, or meeting.
_Avoid_: Channel, message type

**Message Batch**:
One or more accepted instant messages from the same Conversation Scope that are treated as one agent input. Messages in a batch may have different senders.
_Avoid_: Conversation, Session, Run

**Command**:
An instant message that asks the bridge itself to inspect or change bridge state instead of asking an agent to perform work.
_Avoid_: Prompt, Run

**Run**:
One bounded execution of an agent for an Invocation within a Conversation Scope. A Run may continue an existing Session or begin a new one.
_Avoid_: Session, Conversation Scope, Reply

## Context and replies

**Quoted Message**:
A prior message explicitly referenced by a user's reply and supplied as context for the Run. A Topic's structural root is not a Quoted Message merely because later messages point to it.
_Avoid_: Topic Context, parent message

**Topic Context**:
Earlier messages from the same Topic supplied when the bridge first joins that Topic's conversation. It is ambient conversation history, not an explicit quote.
_Avoid_: Quoted Message, Session history

**Reply**:
User-visible output from a Run, delivered on the Invocation Source. An instant-message Reply belongs to the same Conversation Scope as its Message Batch.
_Avoid_: Agent event, transport response

**Progress Reply**:
A Reply that exposes useful intermediate Run output and may be updated while the Run remains active.
_Avoid_: Final Reply, typing indicator

**Final Reply**:
The terminal user-visible answer or termination notice for a Run.
_Avoid_: Progress Reply, Run result object

## Outcomes

**Run Rejection**:
A refusal made before agent work begins because the Invocation is not permitted or cannot be run safely.
_Avoid_: Run Failure, Delivery Failure

**Run Termination**:
The terminal outcome of a started Run: completed, interrupted, timed out, or failed.
_Avoid_: Run Rejection, Delivery Failure

**Delivery Failure**:
Failure to create or update a Reply on its Invocation Source, distinct from whether the agent Run itself succeeded.
_Avoid_: Run Failure, Run Rejection
