# Layer Web SDK Design

This document is for those who want to contribute and maintain this framework. See the README.md file if you want to use the framework.

> Note that we will not use polyfils here that aren't absolutely required, as polyfils can affect applications that use this framework.

## Use of the _ and __ in properties and methods

  - starting with `_singleUnderscore` are either `private` or `protected`, and aren't intended for users of the framework to access.
  - starting with `__doubleUnderscore` are generated methods and properties or are intended to be managed by the framework only, and should be considered `private`.

## Object Initialization

You can pass any event handler or property into the constructor, and expect the initialization to happen appropriately.

As a class developer, leave it to the Root class's constructor to copy values in.

```javascript
class Demo extends Root {
    constructor(options) {
        // Manipulate the options if needed before passing them to the root constructor
        options.p1 = options.p1 || false;

        // Copies p1 and other options into this object
        super(options);

        if (this.p1) this.performAction();
    }
}
```

## Object Destruction

Call destroy() on an object to cleanup resources.  In particular, this is useful if the object either subscribes to events on other objects OR other objects subscribe to events from this object.

```javascript
class Demo extends Root {
    destroy() {
        // turn stuff off if needed
        this.shutdown();

        // Cleans up all event pointers
        super.destroy();
    }
}
```
## Object Definition

While a class is defined according to the ES6 standard, some additional behaviors can be added by calling initClass on your class:

```javascript
class Demo extends Root {}
Root.initClass.apply(Demo, [Demo, 'Demo']);
```

This will enhance the object in ways flagged below.

Note that the following syntax does not work due to limitations in IE10 static inheritance:

```javascript
class Demo extends Root {}
Demo.initClass(Demo, 'Demo'); // Will fail in IE10
```
## Properties

In traditional javacript fashion, properties are declared on the prototype:

```javascript
MyClass.prototype.p1 = true;
```

This defines that:

  - There is a property called p1
  - The property's default value is true
  - Eagerly waiting an established standard for putting these IN the class definition instead of below the class definition.

The root class adds the following meaning to this property declaration:

  - If its declared to be a property, then when the constructor is called, its value will be copied in.
  - If a key is passed into the constructor that is not a property (or event), it will be ignored.

If initClass() was called, the following behaviors are added:

  - If there is an `updatePropertyName` or `adjustPropertyName` method defined for the class, `initClass`
  will add an `Object.defineProperty` getter/setter for the property.
  - A property getter/setter will add a `__propertyName` property where the data is actually stored
  - Any time the setter is called with a *new* value, it will
      1. Call an `adjustPropertyName` method if it exists and modify and validate the value before setting (if needed).
      2. Set the property
      3. Call an `updatePropertyName` method so that any side effects of changing the property can be triggered (firing an event, etc...)

### Property Adjusters

Your function must be named `__adjust<cammelCase(propertyName)>` the first letter of your propertyName will always be upper-cased (even if the property itself starts with a lowercase letter).  The adjust function should not set any properties or state, but SHOULD be able to check properties and state to insure the validity of the value.  Results:

  - If the adjuster does not return a value, then the property will be set with the original value. (returning false, null, "" or 0 is considered returning a value!)
  - If the adjuster returns a value, then the property will be set to the returned value.
  - You can also throw an error if the value is simply invalid.

Common use cases for this:

  1. Someone passes in "Hello World" when the expected property value is a MessagePart instance.  We can support this use case by using the adjuster to return a MessagePart that contains "Hello World".
  2. Someone passes in an int when the expected value is a Date. We can create a Date from the int and return that.
  3. Someone passes in "false" for a boolean, and we want to be able to automatically convert that from "false" => false.
  4. p1 should always be greater than p2.  Throw an error if p1 is less than p2, return undefined if its greater than p2.

### Property Updaters

You can add an update method for your property to update behaviors for the new value. Your method is called AFTER the value has been set (unlike adjuster which is called before its set).

your function must be named `__update<cammelCase(propertyName)>` the first letter of your propertyName will always be upperCased (even if the property itself starts with a lowercase letter).

Common use cases for this are:

  1. Trigger an event
  2. Update a behavior
  3. Update rendering on a widget

## Event Handling

The Root class mixes in the backbone event model.  Primarily, this is used via:

```javascript
obj.on('eventName', function() {...}[, context])

obj.on({
    eventName: function() {...}
}[, context]);
```

Context serves two purposes:

  1. It determines the `this` pointer when running the function (minor)
  2. It allows one to unsubscribe all events from that context when trying to destroy that context. (Major!)

```javascript
obj.off('eventName') // removes all events with the name eventName
obj.off(null, f) // removes all events that trigger f
obj.off(null,null, context) // removes all events with the given context
```

Events can be triggered using trigger:

```javascript
obj.trigger('eventName'[, arg])
```
### Events must be defined to be used

Each class provides an Events object that defines what events it supports. Calling trigger on an object with an unsupported event will fail.

Why?

  1. When an object can expose any arbitrarily named string as an event, its good to have a clearly defined API
  2. Listing all the events in one place is usually a pretty convincing way to see when you're library of events/API has gotten too messy.
  3. Makes it easier to validate that a developer is subscribing to the right thing.

Ramifications:

  1. Subscribing to an event that is not a registered event throws an error
  2. Triggering an event that is not a registered event will fail quietly with a console.info().
  3. You probably shouldn't forget to declare your events.

Recommended syntax for declaring your events:

```javascript
MyClass._supportedEvents = ['evt1', 'evt2', 'evt3'].concat(Root._supportedEvents);
```

Replace `Root._supportedEvents` with whatever your parent class is.

Finally, events can be prevented from firing:

```javascript
obj._disableEvents = true;
obj._disableEvents = false;
```

### Passing in event handlers to the constructor

In addition to using 'on' to setup event handlers, Event handlers can be passed into the constructor exactly like properties.

```javascript
class MyObj extends Root {}

MyObj._supportedEvents = ['hello'].concat(Root._supportedEvents);

var myobj = new MyObj({
    hello: function() {
        alert('Hello has been triggered');
    }
});

myobj.trigger('hello') // triggers alert
```

#### WARNING

Do not name properties the same as events, or your constructor will have trouble when you pass that name as a parameter.


## Retry and Recovery logic

### The Online Manager

A key component for reconnect/retry logic is the Online Manager.  The `client.isOnline` actually returns `client.onlineManager.isOnline`, and requests and websocket connect requests
don't happen as long as the client thinks we are offline.

To make matters worse, some ugly browser bugs keep us from relying on `navigator.onLine`; for example, in testing, we frequently saw scenarios where one Chrome tab evaluated `navigator.onLine` to `true` and another tab returned `false`.

1. Any time we go more than 100 seconds without any data from the server (REST responses or Websocket events/responses), flag us as being offline.
   Rationale: The websocket manager is calling `getCounter` every 30 seconds; so it would have had to fail to get any response
   3 times before we give up.
2. While we are offline, ping the server until we determine we are in fact able to connect to the server. Exponential backoff is used; a maximum wait between tests is 60 seconds.
3. Any time there is a browser `online` or `offline` event, check to see if we can in fact reach the server.  Do not trust either event to be wholly accurate.
   We may be online, but still unable to reach any services.  And Chrome tabs in our tests have shown `navigator.onLine` to sometimes be `false` even while connected.
4. If the ping is successful, set us back to `online`, and start the 100 second timer that will set us back to `offline`.



### Websocket Reconnect logic

On dropping a websocket connection, the following steps are taken to reestablish a connection.

1. If the Online Manager says we're offline, do not attempt to reconnect.  Wait for it change state, and then restart this process
2. Schedule the next reconnect attempt using exponential backoff, maximum delay of 30 seconds
3. Websockets are disconnected when a Session Token expires.  Any subsequent attempt to connect with such a Session Token will fail.  Javascript can not access this error.
   To determine if we should be able to connect prior to connecting the websocket, a REST API call is made to the server with the following results:
   * Session token is accepted; websocket's `connect()` call is made
   * Session is rejected; this error is captured by `client-authenticator.js` and reauthentication process kicks off
   * Request fails to get a response; Online Manager detects this, and pings the server to verify if we are still onlinethat either validates the session token, or
   on failing, kicks off a reauthentication process.
   * Request fails to get a response; Scheulde next reconnect attempt


### Websocket Recovery logic

There are two aspects to Websocket Recovery:

* Detection
* Recovery steps

#### Detection

Websockets use a Ping operation to verify that they are still connected.  In theory, its possible to be disconnected without the browser reporting it to the client (ahem, Chrome, ahem); typically this is supported
by browsers doing a ping; but as Chrome doesn't ping, we've added a Ping operation.  This ping operation may cause Chrome to finally admit that it no longer has a working connection and report an error, triggering [Websocket Reconnect logic](#websocket_reconnect_logic)

Furthermore, because Chrome automatically reconnects a websocket without reporting that it ever disconnected, it becomes difficult to detect that we ever had a bad connection.  We address this with a `counter` that is part of most websocket packets.

* The first counter from the server is 0
* Every susequent counter is incremented by 1
* Frames are gaurenteed to arrive in the order sent
* Any time the counter increments by more than 1, something has gone wrong (unclear if this is possible)
* Any time the counter resets to 0, our connection has been reset, and we have a new websocket session.


Note that detection of a reset websocket session means we do have a valid session, but must execute the [Sync Manager Session Reset logic](#sync_manager_session_reset_logic).

### Socket Manager Session Reset logic

#### First time connection

On establishing the _first_ websocket connection, the following requests are performed:

* `Presence.subscribe`: Subscribe for presence changes to users followed by the current user
* `Presence.update`: Tell the server to re-enable the last used Presence status for the current user

Note that you may also see `Presence.sync` with a list of Identity IDs.  However, this is based entirely the Client receiving identities for which it lacks presence data, and is not handled by the websocket.

Also note that if no websocket data is ever received, reconnects will be treated as a First time connection.

#### Reconnects

Every time that a new websocket connection is reestablished, the following requests are performed:

* `Event.replay`: Request any missed Conversation and Message events from the server
* `Presence.subscribe`: Subscribe for presence changes to users followed by the current user
* `Presence.update`: Tell the server to re-enable the last used Presence status for the current user
* `Presence.sync`: Request any missed presence changes since our last websocket event

### Sync Manager Retry logic

Most requests to Layer's servers go through a Sync Manager that insures that the request gets sent, and handles retries in the event of failure.  There are a few exceptions:

* Queries
* Fetching of individual objects

These do not perform retries on failure because Clients whose queries are not getting responses should get quick errors rather than continual retries.

In the event that the sync manager sends a REST API or Websocket request that fails:

* If the error is an authentication error, `client-authenticator.js` intercepts this and kicks off reauthentication.  The request will be retried once reauthenticated.
* If the error is that we failed to reach the server, or received a `server_unavailable`/`503` error, use exponential backoff with retries, not to excede 60 seconds between retries and not to excede 20 retries total.
* If the error is of the non-recoverable type `not_found`, `id_in_use`, or any unexpected errors that we don't have built in handling for, the request is aborted and removed from the Sync Manager's queue.
* If we have retried 20 times, the request is aborted and removed from the Sync Manager's queue.
* If we appear to be offline, sync manager will retry once Online Manager reports that we are reconnected
* If we keep being told by the sync manager that we are online, but get responses that the Online Manager takes to imply that we are offline, this implies we are receiving CORS errors. 3 repetitions of this pattern in a row is treated as a CORS error.  Abort and remove the request.
