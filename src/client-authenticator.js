/**
 * Layer Client.  Access the layer by calling create and receiving it
 * from the "ready" callback.

  var client = new layer.Client({
    appId: "layer:///apps/staging/ffffffff-ffff-ffff-ffff-ffffffffffff",
    isTrustedDevice: false,
    challenge: function(evt) {
      myAuthenticator({
        nonce: evt.nonce,
        onSuccess: evt.callback
      });
    },
    ready: function(client) {
      alert("Yay, I finally got my client!");
    }
  }).connect("sampleuserId");

 * The Layer Client/ClientAuthenticator classes have been divided into:
 *
 * 1. ClientAuthenticator: Manages all authentication and connectivity related issues
 * 2. Client: Manages access to Conversations, Queries, Messages, Events, etc...
 *
 * @class layer.ClientAuthenticator
 * @private
 * @extends layer.Root
 * @author Michael Kantor
 *
 */

const xhr = require('./xhr');
const Root = require('./root');
const SocketManager = require('./websockets/socket-manager');
const WebsocketChangeManager = require('./websockets/change-manager');
const WebsocketRequestManager = require('./websockets/request-manager');
const LayerError = require('./layer-error');
const OnlineManager = require('./online-state-manager');
const SyncManager = require('./sync-manager');
const DbManager = require('./db-manager');
const Identity = require('./models/identity');
const { XHRSyncEvent, WebsocketSyncEvent } = require('./sync-event');
const { ACCEPT, LOCALSTORAGE_KEYS } = require('./const');
const logger = require('./logger');
const Util = require('./client-utils');

const MAX_XHR_RETRIES = 3;

class ClientAuthenticator extends Root {

  /**
   * Create a new Client.
   *
   * The appId is the only required parameter:
   *
   *      var client = new Client({
   *          appId: "layer:///apps/staging/uuid"
   *      });
   *
   * For trusted devices, you can enable storage of data to indexedDB and localStorage with the `isTrustedDevice` and `isPersistenceEnabled` property:
   *
   *      var client = new Client({
   *          appId: "layer:///apps/staging/uuid",
   *          isTrustedDevice: true,
   *          isPersistenceEnabled: true
   *      });
   *
   * @method constructor
   * @param  {Object} options
   * @param  {string} options.appId           - "layer:///apps/production/uuid"; Identifies what
   *                                            application we are connecting to.
   * @param  {string} [options.url=https://api.layer.com] - URL to log into a different REST server
   * @param {number} [options.logLevel=ERROR] - Provide a log level that is one of layer.Constants.LOG.NONE, layer.Constants.LOG.ERROR,
   *                                            layer.Constants.LOG.WARN, layer.Constants.LOG.INFO, layer.Constants.LOG.DEBUG
   * @param {boolean} [options.isTrustedDevice=false] - If this is not a trusted device, no data will be written to indexedDB nor localStorage,
   *                                            regardless of any values in layer.Client.persistenceFeatures.
   * @param {Object} [options.isPersistenceEnabled=false] If layer.Client.isPersistenceEnabled is true, then indexedDB will be used to manage a cache
   *                                            allowing Query results, messages sent, and all local modifications to be persisted between page reloads.
   */
  constructor(options) {
    // Validate required parameters
    if (!options.appId) throw new Error(LayerError.dictionary.appIdMissing);

    super(options);
  }

  /**
   * Initialize the subcomponents of the ClientAuthenticator
   *
   * @method _initComponents
   * @private
   */
  _initComponents() {
    // Setup the websocket manager; won't connect until we trigger an authenticated event
    this.socketManager = new SocketManager({
      client: this,
    });

    this.socketChangeManager = new WebsocketChangeManager({
      client: this,
      socketManager: this.socketManager,
    });

    this.socketRequestManager = new WebsocketRequestManager({
      client: this,
      socketManager: this.socketManager,
    });

    this.onlineManager = new OnlineManager({
      socketManager: this.socketManager,
    });

    this.onlineManager.on('connected', this._handleOnlineChange, this);
    this.onlineManager.on('disconnected', this._handleOnlineChange, this);

    this.syncManager = new SyncManager({
      onlineManager: this.onlineManager,
      socketManager: this.socketManager,
      requestManager: this.socketRequestManager,
      client: this,
    });
  }

  /**
   * Destroy the subcomponents of the ClientAuthenticator
   *
   * @method _destroyComponents
   * @private
   */
  _destroyComponents() {
    this.syncManager.destroy();
    this.onlineManager.destroy();
    this.socketManager.destroy();
    this.socketChangeManager.destroy();
    this.socketRequestManager.destroy();
    if (this.dbManager) this.dbManager.destroy();
  }


  /**
   * Is Persisted Session Tokens disabled?
   *
   * @method _isPersistedSessionsDisabled
   * @returns {Boolean}
   * @private
   */
  _isPersistedSessionsDisabled() {
    return !global.localStorage || (this.persistenceFeatures && !this.persistenceFeatures.sessionToken);
  }

  /**
   * Restore the sessionToken from localStorage.
   *
   * This sets the sessionToken rather than returning the token.
   *
   * @method _restoreLastSession
   * @private
   */
  _restoreLastSession() {
    if (this._isPersistedSessionsDisabled()) return;
    try {
      const sessionData = global.localStorage[LOCALSTORAGE_KEYS.SESSIONDATA + this.appId];
      if (!sessionData) return;
      const parsedData = JSON.parse(sessionData);
      if (parsedData.expires < Date.now()) {
        global.localStorage.removeItem(LOCALSTORAGE_KEYS.SESSIONDATA + this.appId);
      } else {
        this.sessionToken = parsedData.sessionToken;
      }
    } catch (error) {
      // No-op
    }
  }

  /**
   * Restore the Identity for the session owner from localStorage.
   *
   * @method _restoreLastSession
   * @private
   * @return {layer.Identity}
   */
  _restoreLastUser() {
    try {
      const sessionData = global.localStorage[LOCALSTORAGE_KEYS.SESSIONDATA + this.appId];
      if (!sessionData) return null;
      const userObj = JSON.parse(sessionData).user;
      return new Identity({
        clientId: this.appId,
        sessionOwner: true,
        fromServer: userObj,
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Has the userID changed since the last login?
   *
   * @method _hasUserIdChanged
   * @param {string} userId
   * @returns {boolean}
   * @private
   */
  _hasUserIdChanged(userId) {
    try {
      const sessionData = global.localStorage[LOCALSTORAGE_KEYS.SESSIONDATA + this.appId];
      if (!sessionData) return true;
      return JSON.parse(sessionData).user.user_id !== userId;
    } catch (error) {
      return true;
    }
  }

  /**
   * Get a nonce and start the authentication process
   *
   * @method
   * @private
   */
  _connect() {
    this._triggerAsync('state-change', {
      started: true,
      type: 'authentication',
      telemetryId: 'auth_time',
      id: null,
    });
    this.xhr({
      url: '/nonces',
      method: 'POST',
      sync: false,
    }, result => this._connectionResponse(result));
  }

  /**
   * Initiates the connection.
   *
   * Called by constructor().
   *
   * Will either attempt to validate the cached sessionToken by getting conversations,
   * or if no sessionToken, will call /nonces to start process of getting a new one.
   *
   * ```javascript
   * var client = new layer.Client({appId: myAppId});
   * client.connect('Frodo-the-Dodo');
   * ```
   *
   * @method connect
   * @param {string} userId - User ID of the user you are logging in as
   * @returns {layer.ClientAuthenticator} this
   */
  connect(userId = '') {
    if (this.isAuthenticated) return this;

    let user;
    this.isConnected = false;
    this._lastChallengeTime = 0;
    this._wantsToBeAuthenticated = true;
    this.user = null;
    this.onlineManager.start();
    if (!this.isTrustedDevice || !userId || this._isPersistedSessionsDisabled() || this._hasUserIdChanged(userId)) {
      this._clearStoredData();
    }


    if (this.isTrustedDevice && userId) {
      this._restoreLastSession(userId);
      user = this._restoreLastUser();
      if (user) this.user = user;
    }

    if (!this.user) {
      this.user = new Identity({
        userId,
        sessionOwner: true,
        clientId: this.appId,
        id: userId ? Identity.prefixUUID + encodeURIComponent(userId) : '',
      });
    }

    if (this.sessionToken && this.user.userId) {
      this._sessionTokenRestored();
    } else {
      this._connect();
    }
    return this;
  }

  /**
   * Initiates the connection with a session token.
   *
   * This call is for use when you have received a Session Token from some other source; such as your server,
   * and wish to use that instead of doing a full auth process.
   *
   * The Client will presume the token to be valid, and will asynchronously trigger the `ready` event.
   * If the token provided is NOT valid, this won't be detected until a request is made using this token,
   * at which point the `challenge` method will trigger.
   *
   * NOTE: The `connected` event will not be triggered on this path.
   *
   * ```javascript
   * var client = new layer.Client({appId: myAppId});
   * client.connectWithSession('Frodo-the-Dodo', mySessionToken);
   * ```
   *
   * @method connectWithSession
   * @param {String} userId
   * @param {String} sessionToken
   * @returns {layer.ClientAuthenticator} this
   */
  connectWithSession(userId, sessionToken) {
    if (this.isAuthenticated) return this;

    let user;
    this.isConnected = false;
    this.user = null;
    this._lastChallengeTime = 0;
    this._wantsToBeAuthenticated = true;
    if (!userId || !sessionToken) throw new Error(LayerError.dictionary.sessionAndUserRequired);
    if (!this.isTrustedDevice || this._isPersistedSessionsDisabled() || this._hasUserIdChanged(userId)) {
      this._clearStoredData();
    }
    if (this.isTrustedDevice) {
      user = this._restoreLastUser();
      if (user) this.user = user;
    }

    this.onlineManager.start();

    if (!this.user) {
      this.user = new Identity({
        userId,
        sessionOwner: true,
        clientId: this.appId,
      });
    }

    this.isConnected = true;
    setTimeout(() => {
      if (!this.isAuthenticated) {
        this._authComplete({ session_token: sessionToken }, false);
      }
    }, 1);
    return this;
  }

  /**
   * Called when our request for a nonce gets a response.
   *
   * If there is an error, calls _connectionError.
   *
   * If there is nonce, calls _connectionComplete.
   *
   * @method _connectionResponse
   * @private
   * @param  {Object} result
   */
  _connectionResponse(result) {
    if (!result.success) {
      this._connectionError(result.data);
    } else {
      this._connectionComplete(result.data);
    }
  }

  /**
   * We are now connected (we have a nonce).
   *
   * If we have successfully retrieved a nonce, then
   * we have entered a "connected" but not "authenticated" state.
   * Set the state, trigger any events, and then start authentication.
   *
   * @method _connectionComplete
   * @private
   * @param  {Object} result
   * @param  {string} result.nonce - The nonce provided by the server
   *
   * @fires connected
   */
  _connectionComplete(result) {
    this.isConnected = true;
    this.trigger('connected');
    this._authenticate(result.nonce);
  }

  /**
   * Called when we fail to get a nonce.
   *
   * @method _connectionError
   * @private
   * @param  {layer.LayerError} err
   *
   * @fires connected-error
   */
  _connectionError(error) {
    this.trigger('connected-error', { error });
  }


  /* CONNECT METHODS END */

  /* AUTHENTICATE METHODS BEGIN */

  /**
   * Start the authentication step.
   *
   * We start authentication by triggering a "challenge" event that
   * tells the app to use the nonce to obtain an identity_token.
   *
   * @method _authenticate
   * @private
   * @param  {string} nonce - The nonce to provide your identity provider service
   *
   * @fires challenge
   */
  _authenticate(nonce) {
    this._lastChallengeTime = Date.now();
    if (nonce) {
      this.trigger('challenge', {
        nonce,
        callback: this.answerAuthenticationChallenge.bind(this),
      });
    }
  }

  /**
   * Accept an identityToken and use it to create a session.
   *
   * Typically, this method is called using the function pointer provided by
   * the challenge event, but it can also be called directly.
   *
   *      getIdentityToken(nonce, function(identityToken) {
   *          client.answerAuthenticationChallenge(identityToken);
   *      });
   *
   * @method answerAuthenticationChallenge
   * @param  {string} identityToken - Identity token provided by your identity provider service
   */
  answerAuthenticationChallenge(identityToken) {
    // Report an error if no identityToken provided
    if (!identityToken) {
      throw new Error(LayerError.dictionary.identityTokenMissing);
    } else {
      const userData = Util.decode(identityToken.split('.')[1]);
      const identityObj = JSON.parse(userData);

      if (!identityObj.prn) {
        throw new Error('Your identity token prn (user id) is empty');
      }

      if (this.user.userId && this.user.userId !== identityObj.prn) {
        throw new Error(LayerError.dictionary.invalidUserIdChange);
      }

      this.user._setUserId(identityObj.prn);

      if (identityObj.display_name) this.user.displayName = identityObj.display_name;
      if (identityObj.avatar_url) this.user.avatarUrl = identityObj.avatar_url;

      this.xhr({
        url: '/sessions',
        method: 'POST',
        sync: false,
        data: {
          identity_token: identityToken,
          app_id: this.appId,
        },
      }, result => this._authResponse(result, identityToken));
    }
  }

  /**
   * Called when our request for a sessionToken receives a response.
   *
   * @private
   * @method _authResponse
   * @param  {Object} result
   * @param  {string} identityToken
   */
  _authResponse(result, identityToken) {
    this._triggerAsync('state-change', {
      ended: true,
      type: 'authentication',
      telemetryId: 'auth_time',
      result: result.success,
    });
    if (!result.success) {
      this._authError(result.data, identityToken);
    } else {
      this._authComplete(result.data, false);
    }
  }


  /**
   * Authentication is completed, update state and trigger events.
   *
   * @method _authComplete
   * @private
   * @param  {Object} result
   * @param  {Boolean} fromPersistence
   * @param  {string} result.session_token - Session token received from the server
   *
   * @fires authenticated
   */
  _authComplete(result, fromPersistence) {
    if (!result || !result.session_token) {
      throw new Error(LayerError.dictionary.sessionTokenMissing);
    }
    this.sessionToken = result.session_token;

    // If _authComplete was called because we accepted an auth loaded from storage
    // we don't need to update storage.
    if (!this._isPersistedSessionsDisabled() && !fromPersistence) {
      try {
        global.localStorage[LOCALSTORAGE_KEYS.SESSIONDATA + this.appId] = JSON.stringify({
          sessionToken: this.sessionToken || '',
          user: DbManager.prototype._getIdentityData([this.user], true)[0],
          expires: Date.now() + (30 * 60 * 60 * 24 * 1000),
        });
      } catch (e) {
        // Do nothing
      }
    }

    this._clientAuthenticated();
  }

  /**
   * Authentication has failed.
   *
   * @method _authError
   * @private
   * @param  {layer.LayerError} result
   * @param  {string} identityToken Not currently used
   *
   * @fires authenticated-error
   */
  _authError(error, identityToken) {
    this.trigger('authenticated-error', { error });
  }

  /**
   * Sets state and triggers events for both connected and authenticated.
   *
   * If reusing a sessionToken cached in localStorage,
   * use this method rather than _authComplete.
   *
   * @method _sessionTokenRestored
   * @private
   *
   * @fires connected, authenticated
   */
  _sessionTokenRestored() {
    this.isConnected = true;
    this.trigger('connected');
    this._clientAuthenticated();
  }

  /**
   * The client is now authenticated, and doing some setup
   * before calling _clientReady.
   *
   * @method _clientAuthenticated
   * @private
   */
  _clientAuthenticated() {
    // Update state and trigger the event
    this.isAuthenticated = true;
    this.trigger('authenticated');

    if (!this.isTrustedDevice) this.isPersistenceEnabled = false;


    // If no persistenceFeatures are specified, set them all
    // to true or false to match isTrustedDevice.
    if (!this.persistenceFeatures || !this.isPersistenceEnabled) {
      let sessionToken;
      if (this.persistenceFeatures && 'sessionToken' in this.persistenceFeatures) {
        sessionToken = Boolean(this.persistenceFeatures.sessionToken);
      } else {
        sessionToken = this.isTrustedDevice;
      }
      this.persistenceFeatures = {
        conversations: this.isPersistenceEnabled,
        channels: this.isPersistenceEnabled,
        messages: this.isPersistenceEnabled,
        identities: this.isPersistenceEnabled,
        syncQueue: this.isPersistenceEnabled,
        sessionToken,
      };
    }

    // Setup the Database Manager
    if (!this.dbManager) {
      this.dbManager = new DbManager({
        client: this,
        tables: this.persistenceFeatures,
        enabled: this.isPersistenceEnabled,
      });
    }

    // Before calling _clientReady, load the session owner's full Identity.
    if (this.isPersistenceEnabled) {
      this.dbManager.onOpen(() => this._loadUser());
    } else {
      this._loadUser();
    }
  }

  /**
   * Load the session owner's full identity.
   *
   * Note that failure to load the identity will not prevent
   * _clientReady, but is certainly not a desired outcome.
   *
   * @method _loadUser
   */
  _loadUser() {
    // We're done if we got the full identity from localStorage.
    if (this.user.isFullIdentity) {
      this._clientReady();
    } else {
      // load the user's full Identity so we have presence;
      this.user._load();
      this.user.once('identities:loaded', () => {
        if (!this._isPersistedSessionsDisabled()) {
          this._writeSessionOwner();
          this.user.on('identities:change', this._writeSessionOwner, this);
        }
        this._clientReady();
      })
      .once('identities:loaded-error', () => {
        if (!this.user.displayName) this.user.displayName = this.defaultOwnerDisplayName;
        this._clientReady();
      });
    }
  }

  /**
   * Write the latest state of the Session's Identity object to localStorage
   *
   * @method _writeSessionOwner
   * @private
   */
  _writeSessionOwner() {
    try {
      // Update the session data in localStorage with our full Identity.
      const sessionData = JSON.parse(global.localStorage[LOCALSTORAGE_KEYS.SESSIONDATA + this.appId]);
      sessionData.user = DbManager.prototype._getIdentityData([this.user])[0];
      global.localStorage[LOCALSTORAGE_KEYS.SESSIONDATA + this.appId] = JSON.stringify(sessionData);
    } catch (e) {
      // no-op
    }
  }

  /**
   * Called to flag the client as ready for action.
   *
   * This method is called after authenication AND
   * after initial conversations have been loaded.
   *
   * @method _clientReady
   * @private
   * @fires ready
   */
  _clientReady() {
    if (!this.isReady) {
      this.isReady = true;
      this.trigger('ready');
    }
  }


  /* CONNECT METHODS END */


  /* START SESSION MANAGEMENT METHODS */

  /**
   * Deletes your sessionToken from the server, and removes all user data from the Client.
   * Call `client.connect()` to restart the authentication process.
   *
   * This call is asynchronous; some browsers (ahem, safari...) may not have completed the deletion of
   * persisted data if you
   * navigate away from the page.  Use the callback to determine when all necessary cleanup has completed
   * prior to navigating away.
   *
   * Note that while all data should be purged from the browser/device, if you are offline when this is called,
   * your session token will NOT be deleted from the web server.  Why not? Because it would involve retaining the
   * request after all of the user's data has been deleted, or NOT deleting the user's data until we are online.
   *
   * @method logout
   * @param {Function} callback
   * @return {layer.ClientAuthenticator} this
   */
  logout(callback) {
    this._wantsToBeAuthenticated = false;
    let callbackCount = 1,
      counter = 0;
    if (this.isAuthenticated) {
      callbackCount++;
      this.xhr({
        method: 'DELETE',
        url: '/sessions/' + escape(this.sessionToken),
        sync: false,
      }, () => {
        counter++;
        if (counter === callbackCount && callback) callback();
      });
    }

    // Clear data even if isAuthenticated is false
    // Session may have expired, but data still cached.
    this._clearStoredData(() => {
      counter++;
      if (counter === callbackCount && callback) callback();
    });

    this._resetSession();
    return this;
  }


  _clearStoredData(callback) {
    if (global.localStorage) localStorage.removeItem(LOCALSTORAGE_KEYS.SESSIONDATA + this.appId);
    if (this.dbManager) {
      this.dbManager.deleteTables(callback);
    } else if (callback) {
      callback();
    }
  }

  /**
   * Log out/clear session information.
   *
   * Use this to clear the sessionToken and all information from this session.
   *
   * @method _resetSession
   * @private
   */
  _resetSession() {
    this.isReady = false;
    this.isConnected = false;
    this.isAuthenticated = false;

    if (this.sessionToken) {
      this.sessionToken = '';
      if (global.localStorage) {
        localStorage.removeItem(LOCALSTORAGE_KEYS.SESSIONDATA + this.appId);
      }
    }

    this.trigger('deauthenticated');
    this.onlineManager.stop();
  }

  /**
   * Register your IOS device to receive notifications.
   * For use with native code only (Cordova, React Native, Titanium, etc...)
   *
   * @method registerIOSPushToken
   * @param {Object} options
   * @param {string} options.deviceId - Your IOS device's device ID
   * @param {string} options.iosVersion - Your IOS device's version number
   * @param {string} options.token - Your Apple APNS Token
   * @param {string} [options.bundleId] - Your Apple APNS Bundle ID ("com.layer.bundleid")
   * @param {Function} [callback=null] - Optional callback
   * @param {layer.LayerError} callback.error - LayerError if there was an error; null if successful
   */
  registerIOSPushToken(options, callback) {
    this.xhr({
      url: 'push_tokens',
      method: 'POST',
      sync: false,
      data: {
        token: options.token,
        type: 'apns',
        device_id: options.deviceId,
        ios_version: options.iosVersion,
        apns_bundle_id: options.bundleId,
      },
    }, result => callback(result.data));
  }

  /**
   * Register your Android device to receive notifications.
   * For use with native code only (Cordova, React Native, Titanium, etc...)
   *
   * @method registerAndroidPushToken
   * @param {Object} options
   * @param {string} options.deviceId - Your IOS device's device ID
   * @param {string} options.token - Your GCM push Token
   * @param {string} options.senderId - Your GCM Sender ID/Project Number
   * @param {Function} [callback=null] - Optional callback
   * @param {layer.LayerError} callback.error - LayerError if there was an error; null if successful
   */
  registerAndroidPushToken(options, callback) {
    this.xhr({
      url: 'push_tokens',
      method: 'POST',
      sync: false,
      data: {
        token: options.token,
        type: 'gcm',
        device_id: options.deviceId,
        gcm_sender_id: options.senderId,
      },
    }, result => callback(result.data));
  }

  /**
   * Register your Android device to receive notifications.
   * For use with native code only (Cordova, React Native, Titanium, etc...)
   *
   * @method unregisterPushToken
   * @param {string} deviceId - Your IOS device's device ID
   * @param {Function} [callback=null] - Optional callback
   * @param {layer.LayerError} callback.error - LayerError if there was an error; null if successful
   */
  unregisterPushToken(deviceId, callback) {
    this.xhr({
      url: 'push_tokens/' + deviceId,
      method: 'DELETE',
    }, result => callback(result.data));
  }

  /* SESSION MANAGEMENT METHODS END */


  /* ACCESSOR METHODS BEGIN */

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any attempt to execute `this.userAppId = 'xxx'` will cause an error to be thrown
   * if the client is already connected.
   *
   * @private
   * @method __adjustAppId
   * @param {string} value - New appId value
   */
  __adjustAppId() {
    if (this.isConnected) throw new Error(LayerError.dictionary.cantChangeIfConnected);
  }

  /**
   * __ Methods are automatically called by property setters.
   *
   * Any attempt to execute `this.user = userIdentity` will cause an error to be thrown
   * if the client is already connected.
   *
   * @private
   * @method __adjustUser
   * @param {string} user - new Identity object
   */
  __adjustUser(user) {
    if (this.isConnected) {
      throw new Error(LayerError.dictionary.cantChangeIfConnected);
    }
  }

  // Virtual methods
  _addIdentity(identity) {}
  _removeIdentity(identity) {}


  /* ACCESSOR METHODS END */


  /* COMMUNICATIONS METHODS BEGIN */
  sendSocketRequest(data, callback) {
    const isChangesArray = Boolean(data.isChangesArray);
    if (this._wantsToBeAuthenticated && !this.isAuthenticated) this._connect();

    if (data.sync) {
      const target = data.sync.target;
      let depends = data.sync.depends;
      if (target && !depends) depends = [target];

      this.syncManager.request(new WebsocketSyncEvent({
        data: data.body,
        operation: data.method,
        returnChangesArray: isChangesArray,
        target,
        depends,
        callback,
      }));
    } else {
      if (typeof data.data === 'function') data.data = data.data();
      this.socketRequestManager.sendRequest({ data, isChangesArray, callback });
    }
  }


  /**
   * This event handler receives events from the Online State Manager and generates an event for those subscribed
   * to client.on('online')
   *
   * @method _handleOnlineChange
   * @private
   * @param {layer.LayerEvent} evt
   */
  _handleOnlineChange(evt) {
    if (!this._wantsToBeAuthenticated) return;
    const duration = evt.offlineDuration;
    const isOnline = evt.eventName === 'connected';
    const obj = { isOnline };
    if (isOnline) {
      obj.reset = duration > ClientAuthenticator.ResetAfterOfflineDuration;

      // TODO: Use a cached nonce if it hasn't expired
      if (!this.isAuthenticated) this._connect();
    }
    this.trigger('online', obj);
  }

  /**
   * Main entry point for sending xhr requests or for queing them in the syncManager.
   *
   * This call adjust arguments for our REST server.
   *
   * @method xhr
   * @protected
   * @param  {Object}   options
   * @param  {string}   options.url - URL relative client's url: "/conversations"
   * @param  {Function} callback
   * @param  {Object}   callback.result
   * @param  {Mixed}    callback.result.data - If an error occurred, this is a layer.LayerError;
   *                                          If the response was application/json, this will be an object
   *                                          If the response was text/empty, this will be text/empty
   * @param  {XMLHttpRequest} callback.result.xhr - Native xhr request object for detailed analysis
   * @param  {Object}         callback.result.Links - Hash of Link headers
   * @return {layer.ClientAuthenticator} this
   */
  xhr(options, callback) {
    if (!options.sync || !options.sync.target) {
      options.url = this._xhrFixRelativeUrls(options.url || '');
    }

    options.withCredentials = true;
    if (!options.method) options.method = 'GET';
    if (!options.headers) options.headers = {};
    this._xhrFixHeaders(options.headers);
    this._xhrFixAuth(options.headers);


    // Note: this is not sync vs async; this is syncManager vs fire it now
    if (options.sync === false) {
      this._nonsyncXhr(options, callback, 0);
    } else {
      this._syncXhr(options, callback);
    }
    return this;
  }

  /**
   * For xhr calls that go through the sync manager, queue it up.
   *
   * @method _syncXhr
   * @private
   * @param  {Object}   options
   * @param  {Function} callback
   */
  _syncXhr(options, callback) {
    if (!options.sync) options.sync = {};
    if (this._wantsToBeAuthenticated && !this.isAuthenticated) this._connect();

    const innerCallback = (result) => {
      this._xhrResult(result, callback);
    };
    const target = options.sync.target;
    let depends = options.sync.depends;
    if (target && !depends) depends = [target];

    this.syncManager.request(new XHRSyncEvent({
      url: options.url,
      data: options.data,
      telemetry: options.telemetry,
      method: options.method,
      operation: options.sync.operation || options.method,
      headers: options.headers,
      callback: innerCallback,
      target,
      depends,
    }));
  }

  /**
   * For xhr calls that don't go through the sync manager,
   * fire the request, and if it fails, refire it up to 3 tries
   * before reporting an error.  1 second delay between requests
   * so whatever issue is occuring is a tiny bit more likely to resolve,
   * and so we don't hammer the server every time there's a problem.
   *
   * @method _nonsyncXhr
   * @private
   * @param  {Object}   options
   * @param  {Function} callback
   * @param  {number}   retryCount
   */
  _nonsyncXhr(options, callback, retryCount) {
    xhr(options, (result) => {
      if ([502, 503, 504].indexOf(result.status) !== -1 && retryCount < MAX_XHR_RETRIES) {
        setTimeout(() => this._nonsyncXhr(options, callback, retryCount + 1), 1000);
      } else {
        this._xhrResult(result, callback);
      }
    });
  }

  /**
   * Fix authentication header for an xhr request
   *
   * @method _xhrFixAuth
   * @private
   * @param  {Object} headers
   */
  _xhrFixAuth(headers) {
    if (this.sessionToken && !headers.Authorization) {
      headers.authorization = 'Layer session-token="' + this.sessionToken + '"'; // eslint-disable-line
    }
  }

  /**
   * Fix relative URLs to create absolute URLs needed for CORS requests.
   *
   * @method _xhrFixRelativeUrls
   * @private
   * @param  {string} relative or absolute url
   * @return {string} absolute url
   */
  _xhrFixRelativeUrls(url) {
    let result = url;
    if (url.indexOf('https://') === -1) {
      if (url[0] === '/') {
        result = this.url + url;
      } else {
        result = this.url + '/' + url;
      }
    }
    return result;
  }

  /**
   * Fixup all headers in preparation for an xhr call.
   *
   * 1. All headers use lower case names for standard/easy lookup
   * 2. Set the accept header
   * 3. If needed, set the content-type header
   *
   * @method _xhrFixHeaders
   * @private
   * @param  {Object} headers
   */
  _xhrFixHeaders(headers) {
    // Replace all headers in arbitrary case with all lower case
    // for easy matching.
    const headerNameList = Object.keys(headers);
    headerNameList.forEach((headerName) => {
      if (headerName !== headerName.toLowerCase()) {
        headers[headerName.toLowerCase()] = headers[headerName];
        delete headers[headerName];
      }
    });

    if (!headers.accept) headers.accept = ACCEPT;

    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  /**
   * Handle the result of an xhr call
   *
   * @method _xhrResult
   * @private
   * @param  {Object}   result     Standard xhr response object from the xhr lib
   * @param  {Function} [callback] Callback on completion
   */
  _xhrResult(result, callback) {
    if (this.isDestroyed) return;

    if (!result.success) {
      // Replace the response with a LayerError instance
      if (result.data && typeof result.data === 'object') {
        this._generateError(result);
      }

      // If its an authentication error, reauthenticate
      // don't call _resetSession as that wipes all data and screws with UIs, and the user
      // is still authenticated on the customer's app even if not on Layer.
      if (result.status === 401 && this._wantsToBeAuthenticated) {
        if (this.isAuthenticated) {
          logger.warn('SESSION EXPIRED!');
          this.isAuthenticated = false;
          this.isReady = false;
          if (global.localStorage) localStorage.removeItem(LOCALSTORAGE_KEYS.SESSIONDATA + this.appId);
          this.trigger('deauthenticated');
          if (result.data && result.data.getNonce) {
            this._authenticate(result.data.getNonce());
          }
        }

        else if (this._lastChallengeTime > Date.now() + ClientAuthenticator.TimeBetweenReauths) {
          if (result.data && result.data.getNonce) {
            this._authenticate(result.data.getNonce());
          }
        }
      }
    }
    if (callback) callback(result);
  }

  /**
   * Transforms xhr error response into a layer.LayerError instance.
   *
   * Adds additional information to the result object including
   *
   * * url
   * * data
   *
   * @method _generateError
   * @private
   * @param  {Object} result - Result of the xhr call
   */
  _generateError(result) {
    result.data = new LayerError(result.data);
    if (!result.data.httpStatus) result.data.httpStatus = result.status;
    result.data.log();
  }

  /* END COMMUNICATIONS METHODS */

}

/**
 * State variable; indicates that client is currently authenticated by the server.
 * Should never be true if isConnected is false.
 * @type {Boolean}
 * @readonly
 */
ClientAuthenticator.prototype.isAuthenticated = false;

/**
 * State variable; indicates that client is currently connected to server
 * (may not be authenticated yet)
 * @type {Boolean}
 * @readonly
 */
ClientAuthenticator.prototype.isConnected = false;

/**
 * State variable; indicates that client is ready for the app to use.
 * Use the 'ready' event to be notified when this value changes to true.
 *
 * @type {boolean}
 * @readonly
 */
ClientAuthenticator.prototype.isReady = false;

/**
 * State variable; indicates if the WebSDK thinks that the app WANTS to be connected.
 *
 * An app wants to be connected if it has called `connect()` or `connectWithSession()`
 * and has not called `logout()`.  A client that is connected will receive reauthentication
 * events in the form of `challenge` events.
 *
 * @type {boolean}
 * @readonly
 */
ClientAuthenticator.prototype._wantsToBeAuthenticated = false;

/**
 * If presence is enabled, then your presence can be set/restored.
 *
 * @type {Boolean} [isPresenceEnabled=true]
 */
ClientAuthenticator.prototype.isPresenceEnabled = true;

/**
 * Your Layer Application ID. Can not be changed once connected.
 *
 * To find your Layer Application ID, see your Layer Developer Dashboard.
 *
 * @type {String}
 */
ClientAuthenticator.prototype.appId = '';

/**
 * Identity information about the authenticated user.
 *
 * @type {layer.Identity}
 */
ClientAuthenticator.prototype.user = null;

/**
 * Your current session token that authenticates your requests.
 *
 * @type {String}
 * @readonly
 */
ClientAuthenticator.prototype.sessionToken = '';

/**
 * Time that the last challenge was issued
 *
 * @type {Number}
 * @private
 */
ClientAuthenticator.prototype._lastChallengeTime = 0;

/**
 * URL to Layer's Web API server.
 *
 * Only muck with this if told to by Layer Staff.
 * @type {String}
 */
ClientAuthenticator.prototype.url = 'https://api.layer.com';

/**
 * URL to Layer's Websocket server.
 *
 * Only muck with this if told to by Layer Staff.
 * @type {String}
 */
ClientAuthenticator.prototype.websocketUrl = 'wss://websockets.layer.com';

/**
 * Web Socket Manager
 * @type {layer.Websockets.SocketManager}
 */
ClientAuthenticator.prototype.socketManager = null;

/**
 * Web Socket Request Manager
 * @type {layer.Websockets.RequestManager}
 */
ClientAuthenticator.prototype.socketRequestManager = null;

/**
 * Web Socket Manager
 * @type {layer.Websockets.ChangeManager}
 */
ClientAuthenticator.prototype.socketChangeManager = null;

/**
 * Service for managing online as well as offline server requests
 * @type {layer.SyncManager}
 */
ClientAuthenticator.prototype.syncManager = null;

/**
 * Service for managing online/offline state and events
 * @type {layer.OnlineStateManager}
 */
ClientAuthenticator.prototype.onlineManager = null;

/**
 * If this is a trusted device, then we can write personal data to persistent memory.
 * @type {boolean}
 */
ClientAuthenticator.prototype.isTrustedDevice = false;

/**
 * To enable indexedDB storage of query data, set this true.  Experimental.
 *
 * @property {boolean}
 */
ClientAuthenticator.prototype.isPersistenceEnabled = false;

/**
 * If this layer.Client.isTrustedDevice is true, then you can control which types of data are persisted.
 *
 * Note that values here are ignored if `isPersistenceEnabled` hasn't been set to `true`.
 *
 * Properties of this Object can be:
 *
 * * identities: Write identities to indexedDB? This allows for faster initialization.
 * * conversations: Write conversations to indexedDB? This allows for faster rendering
 *                  of a Conversation List
 * * messages: Write messages to indexedDB? This allows for full offline access
 * * syncQueue: Write requests made while offline to indexedDB?  This allows the app
 *              to complete sending messages after being relaunched.
 * * sessionToken: Write the session token to localStorage for quick reauthentication on relaunching the app.
 *
 *      new layer.Client({
 *        isTrustedDevice: true,
 *        persistenceFeatures: {
 *          conversations: true,
 *          identities: true,
 *          messages: false,
 *          syncQueue: false,
 *          sessionToken: true
 *        }
 *      });
 *
 * @type {Object}
 */
ClientAuthenticator.prototype.persistenceFeatures = null;

/**
 * Database Manager for read/write to IndexedDB
 * @type {layer.DbManager}
 */
ClientAuthenticator.prototype.dbManager = null;

/**
 * If a display name is not loaded for the session owner, use this name.
 *
 * @type {string}
 */
ClientAuthenticator.prototype.defaultOwnerDisplayName = 'You';

/**
 * Is true if the client is authenticated and connected to the server;
 *
 * Typically used to determine if there is a connection to the server.
 *
 * Typically used in conjunction with the `online` event.
 *
 * @type {boolean}
 */
Object.defineProperty(ClientAuthenticator.prototype, 'isOnline', {
  enumerable: true,
  get: function get() {
    return this.onlineManager && this.onlineManager.isOnline;
  },
});

/**
 * Log levels; one of:
 *
 *    * layer.Constants.LOG.NONE
 *    * layer.Constants.LOG.ERROR
 *    * layer.Constants.LOG.WARN
 *    * layer.Constants.LOG.INFO
 *    * layer.Constants.LOG.DEBUG
 *
 * @type {number}
 */
Object.defineProperty(ClientAuthenticator.prototype, 'logLevel', {
  enumerable: false,
  get: function get() { return logger.level; },
  set: function set(value) { logger.level = value; },
});

/**
 * Short hand for getting the userId of the authenticated user.
 *
 * Could also just use client.user.userId
 *
 * @type {string} userId
 */
Object.defineProperty(ClientAuthenticator.prototype, 'userId', {
  enumerable: true,
  get: function get() {
    return this.user ? this.user.userId : '';
  },
  set: function set() {},
});

/**
 * Time to be offline after which we don't do a WebSocket Events.replay,
 * but instead just refresh all our Query data.  Defaults to 30 hours.
 *
 * @type {number}
 * @static
 */
ClientAuthenticator.ResetAfterOfflineDuration = 1000 * 60 * 60 * 30;

/**
 * Number of miliseconds delay must pass before a subsequent challenge is issued.
 *
 * This value is here to insure apps don't get challenge requests while they are
 * still processing the last challenge event.
 *
 * @property {Number}
 * @static
 */
ClientAuthenticator.TimeBetweenReauths = 30 * 1000;

/**
 * List of events supported by this class
 * @static
 * @protected
 * @type {string[]}
 */
ClientAuthenticator._supportedEvents = [
  /**
   * The client is ready for action
   *
   *      client.on('ready', function(evt) {
   *          renderMyUI();
   *      });
   *
   * @event
   */
  'ready',

  /**
   * Fired when connected to the server.
   * Currently just means we have a nonce.
   * Not recommended for typical applications.
   * @event connected
   */
  'connected',

  /**
   * Fired when unsuccessful in obtaining a nonce.
   *
   * Not recommended for typical applications.
   * @event connected-error
   * @param {Object} event
   * @param {layer.LayerError} event.error
   */
  'connected-error',

  /**
   * We now have a session and any requests we send aught to work.
   * Typically you should use the ready event instead of the authenticated event.
   * @event authenticated
   */
  'authenticated',

  /**
   * Failed to authenticate your client.
   *
   * Either your identity-token was invalid, or something went wrong
   * using your identity-token.
   *
   * @event authenticated-error
   * @param {Object} event
   * @param {layer.LayerError} event.error
   */
  'authenticated-error',

  /**
   * This event fires when a session has expired or when `layer.Client.logout` is called.
   * Typically, it is enough to subscribe to the challenge event
   * which will let you reauthenticate; typical applications do not need
   * to subscribe to this.
   *
   * @event deauthenticated
   */
  'deauthenticated',

  /**
   * @event challenge
   * Verify the user's identity.
   *
   * This event is where you verify that the user is who we all think the user is,
   * and provide an identity token to validate that.
   *
   * ```javascript
   * client.on('challenge', function(evt) {
   *    myGetIdentityForNonce(evt.nonce, function(identityToken) {
   *      evt.callback(identityToken);
   *    });
   * });
   * ```
   *
   * @param {Object} event
   * @param {string} event.nonce - A nonce for you to provide to your identity provider
   * @param {Function} event.callback - Call this once you have an identity-token
   * @param {string} event.callback.identityToken - Identity token provided by your identity provider service
   */
  'challenge',

  /**
   * @event session-terminated
   * If your session has been terminated in such a way as to prevent automatic reconnect,
   *
   * this event will fire.  Common scenario: user has two tabs open;
   * one tab the user logs out (or you call client.logout()).
   * The other tab will detect that the sessionToken has been removed,
   * and will terminate its session as well.  In this scenario we do not want
   * to automatically trigger a challenge and restart the login process.
   */
  'session-terminated',

  /**
   * @event online
   *
   * This event is used to detect when the client is online (connected to the server)
   * or offline (still able to accept API calls but no longer able to sync to the server).
   *
   *      client.on('online', function(evt) {
   *         if (evt.isOnline) {
   *             statusDiv.style.backgroundColor = 'green';
   *         } else {
   *             statusDiv.style.backgroundColor = 'red';
   *         }
   *      });
   *
   * @param {Object} event
   * @param {boolean} event.isOnline
   */
  'online',


  /**
   * State change events are used for internal communications.
   *
   * Primarily used so that the Telemetry component can monitor and report on
   * system activity.
   *
   * @event
   * @private
   */
  'state-change',

  /**
   * An operation has been received via the websocket.
   *
   * Used for custom/complex operations that cannot be handled via `udpate` requests.
   *
   * @event
   * @private
   */
  'websocket:operation',
].concat(Root._supportedEvents);

Root.initClass.apply(ClientAuthenticator, [ClientAuthenticator, 'ClientAuthenticator']);

module.exports = ClientAuthenticator;
