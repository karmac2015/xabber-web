define("xabber-contacts", function () {
    return function (xabber) {
        var env = xabber.env,
            constants = env.constants,
            templates = env.templates.contacts,
            utils = env.utils,
            $ = env.$,
            $iq = env.$iq,
            $msg = env.$msg,
            $pres = env.$pres,
            Strophe = env.Strophe,
            _ = env._,
            moment = env.moment,
            uuid = env.uuid,
            Images = utils.images,
            Emoji = utils.emoji;

        xabber.Contact = Backbone.Model.extend({
            idAttribute: 'jid',
            defaults: {
                status: "offline",
                status_message: "",
                subscription: null,
                groups: [],
                group_chat: false
            },

            initialize: function (_attrs, options) {
                this.on("change:group_chat", this.onChangedGroupchat, this);
                this.account = options.account;
                var attrs = _.clone(_attrs);
                (this.account && this.account.connection.domain === attrs.jid) && (attrs.is_server = true);
                attrs.name = attrs.roster_name || attrs.jid;
                if (!attrs.image) {
                    attrs.photo_hash = "";
                    attrs.image = Images.getDefaultAvatar(attrs.name);
                }
                (this.account.domain === attrs.jid) && (attrs.bot = true);
                this.cached_image = Images.getCachedImage(attrs.image);
                attrs.vcard = utils.vcard.getBlank(attrs.jid);
                this.set(attrs);
                this.domain = Strophe.getDomainFromJid(this.get('jid'));
                this.set('group_chat', _.contains(this.account.chat_settings.get('group_chat'), this.get('jid')));
                this.hash_id = env.b64_sha1(this.account.get('jid') + '-' + attrs.jid);
                this.resources = new xabber.ContactResources(null, {contact: this});
                this.details_view = (this.get('group_chat')) ? new xabber.GroupChatDetailsView({model: this}) : new xabber.ContactDetailsView({model: this});
                this.invitation = new xabber.ContactInvitationView({model: this});
                this.on("change:photo_hash", this.getContactInfo, this);
                this.on("change:roster_name", this.updateName, this);
                !xabber.servers.get(this.domain) && xabber.servers.create({domain: this.domain, account: this.account});
                this.account.dfd_presence.done(function () {
                    if (!this.get('blocked'))
                        this.getContactInfo();
                }.bind(this));
            },

            getStatusMessage: function () {
                return this.get('status_message') || constants.STATUSES[this.get('status')];
            },

            getContactInfo: function () {
                xabber.cached_contacts_info.getContactInfo(this.get('jid'), function (contact_info) {
                    if (!_.isNull(contact_info)) {
                        if ((contact_info.hash === this.get('photo_hash')) || !this.get('photo_hash')) {
                            this.cached_image = Images.getCachedImage(contact_info.avatar);
                            contact_info.avatar_priority && this.set('avatar_priority', contact_info.avatar_priority);
                            this.set('photo_hash', contact_info.hash);
                            this.set('image', contact_info.avatar);
                        }
                        else {
                            if (!this.get('group_chat'))
                                this.getVCard();
                        }
                        if (!this.get('roster_name') && contact_info.name)
                            this.set('name', contact_info.name);
                        return;
                    }
                    if (!this.get('group_chat'))
                        this.getVCard();
                }.bind(this));
            },

            getVCard: function (callback) {
                var jid = this.get('jid'),
                    is_callback = _.isFunction(callback);
                this.account.connection.vcard.get(jid,
                    function (vcard) {
                        var attrs = {
                            vcard: vcard,
                            vcard_updated: moment.now(),
                            name: this.get('roster_name')
                        }
                        if (!attrs.name) {
                            if (this.get('group_chat'))
                                attrs.name = vcard.nickname || this.get('name');
                            else
                                attrs.name = vcard.nickname || vcard.fullname || (vcard.first_name + ' ' + vcard.last_name).trim() || jid;
                        }
                        if (!this.get('avatar_priority') || this.get('avatar_priority') <= constants.AVATAR_PRIORITIES.VCARD_AVATAR) {
                            if (vcard.photo.image) {
                                attrs.avatar_priority = constants.AVATAR_PRIORITIES.VCARD_AVATAR;
                                attrs.image = vcard.photo.image;
                            }
                            else
                                attrs.image = Images.getDefaultAvatar(attrs.name);
                            this.cached_image = Images.getCachedImage(attrs.image);
                        }
                        this.set(attrs);
                        if (this.get('photo_hash') || vcard.photo.image) {
                            xabber.cached_contacts_info.putContactInfo({jid: this.get('jid'), hash: (this.get('photo_hash') || this.account.getAvatarHash(vcard.photo.image)), avatar_priority: this.get('avatar_priority'), avatar: this.get('image'), name: this.get('name')});
                        }
                        is_callback && callback(vcard);
                    }.bind(this),
                    function () {
                        is_callback && callback(null);
                    }
                );
            },

            onChangedGroupchat: function () {
                if (this.get('group_chat')) {
                    this.updateCounters();
                    this.participants = new xabber.Participants(null, {contact: this});
                }
            },

            updateCounters: function () {
                xabber.toolbar_view.recountAllMessageCounter();
            },

            getLastSeen: function() {
                if (this.get('status') == 'offline') {
                    if (!Strophe.getNodeFromJid(this.get('jid'))) {
                        this.set({status_message: 'Server'});
                        return;
                    }
                    var iq = $iq({from: this.account.get('jid'), type: 'get', to: this.get('jid') }).c('query', {xmlns: Strophe.NS.LAST});
                    this.account.sendIQ(iq, function (iq) {
                        var last_seen = this.getLastSeenStatus(iq);
                        if (this.get('status') == 'offline')
                            this.set({status_message: last_seen});
                        return this;
                    }.bind(this));
                }
            },

            membersRequest: function (options, callback) {
                let participant_id = options.id,
                    version = options.version || 0;
                var iq = $iq({from: this.account.get('jid'), to: this.get('jid'), type: 'get'});
                if (participant_id != undefined)
                    iq.c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#members', id: participant_id});
                else
                    iq.c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#members', version: version});
                this.account.sendIQ(iq, function (response) {
                    callback && callback(response);
                });
            },

            getMyInfo: function (callback) {
                this.membersRequest({id: ''}, function (response) {
                    let $item = $($(response).find('query item')),
                        cached_avatar = this.account.chat_settings.getAvatarInfoById($item.find('id').text());
                    $item.length && this.participants && this.participants.createFromStanza($item);
                    cached_avatar && (cached_avatar.avatar_hash == this.my_info.get('avatar')) && this.my_info.set('b64_avatar', cached_avatar.avatar_b64);
                    this.trigger('update_my_info');
                    callback && callback();
                }.bind(this));
            },

            getAvatar: function (avatar, node, callback, errback) {
                var iq_request_avatar = $iq({from: this.account.get('jid'), type: 'get', to: this.get('jid')})
                    .c('pubsub', {xmlns: Strophe.NS.PUBSUB})
                    .c('items', {node: node})
                    .c('item', {id: avatar});
                this.account.sendIQ(iq_request_avatar, function (iq) {
                    var pubsub_avatar = $(iq).find('data').text();
                    if (pubsub_avatar == "")
                        errback && errback("Node is empty");
                    else
                        callback && callback(pubsub_avatar);
                }.bind(this));
            },

            pubAvatar: function (image, node, callback, errback) {
                var avatar_hash = sha1(image.base64),
                    iq_pub_data = $iq({from: this.account.get('jid'), type: 'set', to: this.get('jid') })
                        .c('pubsub', {xmlns: Strophe.NS.PUBSUB})
                        .c('publish', {node: Strophe.NS.PUBSUB_AVATAR_DATA + node})
                        .c('item', {id: avatar_hash})
                        .c('data', {xmlns: Strophe.NS.PUBSUB_AVATAR_DATA}).t(image.base64),
                    iq_pub_metadata = $iq({from: this.account.get('jid'), type: 'set', to: this.get('jid') })
                        .c('pubsub', {xmlns: Strophe.NS.PUBSUB})
                        .c('publish', {node: Strophe.NS.PUBSUB_AVATAR_METADATA + node})
                        .c('item', {id: avatar_hash})
                        .c('metadata', {xmlns: Strophe.NS.PUBSUB_AVATAR_METADATA})
                        .c('info', {bytes: image.size, id: avatar_hash, type: 'image/jpeg'});
                this.account.sendIQ(iq_pub_data, function () {
                        this.account.sendIQ(iq_pub_metadata, function () {
                                callback && callback(avatar_hash);
                            }.bind(this),
                            function (data_error) {
                                errback && errback(data_error);
                            });
                    }.bind(this),
                    function (data_error) {
                        errback && errback(data_error);
                    }.bind(this));
            },

            getLastSeenStatus: function(iq) {
                var seconds = $(iq).children('query').attr('seconds'),
                    message_time = moment.now() - 1000*seconds;
                this.set({ last_seen: message_time });
                return utils.pretty_last_seen(seconds);
            },

            pres: function (type) {
                var pres = $pres({to: this.get('jid'), type: type});
                this.account.sendPres(pres);
                this.trigger('presence', this, type + '_from');
                return this;
            },

            pushInRoster: function (attrs, callback, errback) {
                attrs || (attrs = {});
                var name = attrs.name || this.get('roster_name'),
                    groups = attrs.groups || this.get('groups');
                var iq = $iq({type: 'set'})
                    .c('query', {xmlns: Strophe.NS.ROSTER})
                    .c('item', {jid: this.get('jid'), name: name});
                _.each(groups, function (group) {
                    iq.c('group').t(group).up();
                });
                this.account.sendIQ(iq, callback, errback);
                this.set('known', true);
                return this;
            },

            removeFromRoster: function (callback, errback) {
                var iq = $iq({type: 'set'})
                    .c('query', {xmlns: Strophe.NS.ROSTER})
                    .c('item', {jid: this.get('jid'), subscription: "remove"});
                this.account.cached_roster.removeFromCachedRoster(this.get('jid'));
                this.account.sendIQ(iq, callback, errback);
                this.set('known', false);
                return this;
            },

            acceptRequest: function (callback) {
                this.pres('subscribed');
                callback && callback();
            },

            askRequest: function (callback) {
                this.pres('subscribe');
                callback && callback();
            },

            blockRequest: function (callback) {
                this.pres('unsubscribed');
                this.removeFromRoster().block(callback);
            },

            declineRequest: function (callback) {
                this.pres('unsubscribed');
                this.removeFromRoster(callback);
            },

            declineSubscription: function () {
                this.pres('unsubscribe');
            },

            block: function (callback, errback) {
                var iq = $iq({type: 'set'}).c('block', {xmlns: Strophe.NS.BLOCKING})
                    .c('item', {jid: this.get('jid')});
                this.account.sendIQ(iq, callback, errback);
                this.set('known', false);
            },

            unblock: function (callback, errback) {
                var iq = $iq({type: 'set'}).c('unblock', {xmlns: Strophe.NS.BLOCKING})
                    .c('item', {jid: this.get('jid')});
                this.account.sendIQ(iq, callback, errback);
            },

            subGroupPres: function () {
                var pres = $pres({from: this.account.connection.jid, to: this.get('jid')})
                    .c('x', {xmlns: Strophe.NS.GROUP_CHAT + '#present'});
                this.account.sendPres(pres);
            },

            unsubGroupPres: function () {
                var pres = $pres({from: this.account.connection.jid, to: this.get('jid')})
                    .c('x', {xmlns: Strophe.NS.GROUP_CHAT + '#not-present'});
                this.account.sendPres(pres);
            },

            handlePresence: function (presence) {
                var $presence = $(presence),
                    type = presence.getAttribute('type'),
                    $vcard_update = $presence.find('x[xmlns="'+Strophe.NS.VCARD_UPDATE+'"]');
                if ($vcard_update.length && this.get('avatar_priority') && this.get('avatar_priority') <= constants.AVATAR_PRIORITIES.VCARD_AVATAR)
                    this.set('photo_hash', $vcard_update.find('photo').text());
                if (type === 'subscribe') {
                    if (this.get('in_roster')) {
                        this.pres('subscribed');
                    } else {
                        this.trigger('presence', this, 'subscribe');
                    }
                } else if (type === 'subscribed') {
                    if (this.get('subscription') === 'to') {
                        this.pres('subscribed');
                    }
                    this.trigger('presence', this, 'subscribed');
                } else if (type === 'unsubscribe') {
                    if (this.get('group_chat'))
                        this.removeFromRoster();
                } else if (type === 'unsubscribed') {
                    this.trigger('presence', this, 'unsubscribed');
                } else {
                    var jid = presence.getAttribute('from'),
                        resource = Strophe.getResourceFromJid(jid),
                        priority = Number($presence.find('priority').text()),
                        status = $presence.find('show').text() || 'online',
                        $status_message = $presence.find('status'),
                        status_message = $status_message.text();
                    _.isNaN(priority) && (priority = 0);
                    clearTimeout(this._reset_status_timeout);
                    var resource_obj = this.resources.get(resource);
                    if (type === 'unavailable') {
                        this.set({ last_seen: moment.now() });
                        resource_obj && resource_obj.destroy();
                    } else {
                        this.set({ last_seen: undefined });
                        var attrs = {
                            resource: resource,
                            priority: priority,
                            status: status
                        };
                        $status_message.length && (attrs.status_message = status_message);
                        if (!resource_obj) {
                            resource_obj = this.resources.create(attrs);
                        } else {
                            resource_obj.set(attrs);
                        }
                    }
                }
                if (($(presence).find('x[xmlns="'+Strophe.NS.GROUP_CHAT +'"]').length > 0)&&!($(presence).attr('type') == 'unavailable')) {
                    if (!this.get('group_chat')) {
                        this.set('group_chat', true);
                        this.account.chat_settings.updateGroupChatsList(this.get('jid'), this.get('group_chat'));
                    }
                    if (!this.details_view.child('participants')) {
                        this.details_view = new xabber.GroupChatDetailsView({model: this});
                    }
                    let group_chat_info = this.parseGroupInfo($(presence));
                    this.set('group_info', group_chat_info);
                    if (!this.get('roster_name') && (group_chat_info.name !== this.get('name')))
                        this.set('name', group_chat_info.name);
                    this.set('status_message', (group_chat_info.members_num + ' participants, ' + group_chat_info.online_members_num + ' online'));
                }
            },

            parseGroupInfo: function ($presence) {
                var $group_chat = $presence.find('x[xmlns="'+Strophe.NS.GROUP_CHAT +'"]'),
                    name = $group_chat.find('name').text(),
                    model = $group_chat.find('membership').text(),
                    anonymous = $group_chat.find('privacy').text(),
                    searchable = $group_chat.find('index').text(),
                    description = $group_chat.find('description').text(),
                    pinned_message = $group_chat.find('pinned-message').text(),
                    private_chat = $group_chat.find('parent-chat').text() || false,
                    members_num = parseInt($group_chat.find('members').text()),
                    online_members_num = parseInt($group_chat.find('present').text()),
                    info = {
                        jid: this.get('jid'),
                        name: name,
                        anonymous: anonymous,
                        searchable: searchable,
                        model: model,
                        description: description,
                        members_num: members_num,
                        online_members_num: online_members_num
                    };
                private_chat && this.set('private_chat', private_chat);
                anonymous === 'incognito' && this.set('incognito_chat', true);
                var chat = this.account.chats.get(this.hash_id), pinned_msg_elem;
                if (chat)
                    pinned_msg_elem = chat.item_view.content.$pinned_message;
                if (pinned_msg_elem) {
                    if (pinned_message && pinned_message != "") {
                        this.getMessageByStanzaId(pinned_message, function ($message) {
                            this.parsePinnedMessage($message, pinned_msg_elem);
                        }.bind(this));
                    }
                    if (pinned_message == "") {
                        this.set('pinned_message', undefined);
                        this.parsePinnedMessage(undefined, pinned_msg_elem);
                    }
                }

                return info;
            },

            getAllRights: function (callback) {
                let iq_get_rights = iq = $iq({from: this.account.get('jid'), type: 'get', to: this.get('jid') })
                    .c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#rights' });
                this.account.sendIQ(iq_get_rights, function(iq_all_rights) {
                    var all_permissions = $(iq_all_rights).find('permission'),
                        all_restrictions = $(iq_all_rights).find('restriction');
                    this.all_rights = {permissions: all_permissions, restrictions: all_restrictions};
                    callback && callback();
                }.bind(this));
            },

            getMessageByStanzaId: function (stanza_id, callback) {
                var queryid = uuid(),
                    iq = $iq({type: 'set', to: this.get('jid')})
                        .c('query', {xmlns: Strophe.NS.MAM, queryid: queryid})
                        .c('x', {xmlns: Strophe.NS.XDATA, type: 'submit'})
                        .c('field', {'var': 'FORM_TYPE', type: 'hidden'})
                        .c('value').t(Strophe.NS.MAM).up().up()
                        .c('field', {'var': '{urn:xmpp:sid:0}stanza-id'})
                        .c('value').t(stanza_id);
                var handler = this.account.connection.addHandler(function (message) {
                    var $msg = $(message);
                    if ($msg.find('result').attr('queryid') === queryid)
                        callback && callback($msg);
                    return true;
                }.bind(this), Strophe.NS.MAM);
                this.account.sendIQ(iq,
                    function () {
                        this.account.connection.deleteHandler(handler);
                    }.bind(this),
                    function () {
                        this.account.connection.deleteHandler(handler);
                    }.bind(this)
                );
            },

            parsePinnedMessage: function ($message, pinned_msg_elem) {
                if (!$message) {
                    this.renderPinnedMessage(null, pinned_msg_elem);
                }
                else {
                    var $msg = $message.find('result message').first();
                    if (this.get('pinned_message'))
                        if (this.get('pinned_message').archive_id === $msg.find('stanza-id').attr('id'))
                            return;
                    var message = this.account.chats.receiveChatMessage($message, {pinned_message: true});
                    this.set('pinned_message', message);
                    this.renderPinnedMessage(message, pinned_msg_elem);
                }
            },

            renderPinnedMessage: function (message, pinned_msg_elem) {
                if (!message) {
                    pinned_msg_elem.html("");
                    pinned_msg_elem.siblings('.chat-content').css({'height':'100%'});
                }
                else {
                    var images = message.get('images'),
                        files = message.get('files'),
                        fwd_message = message.get('forwarded_message'),
                        fwd_msg_author = null,
                        msg_text = message.get('message');
                    if (fwd_message) {
                        let user_info = fwd_message[0].get('user_info') || {};
                        if (fwd_message.length > 1)
                            msg_text = fwd_message.length + ' forwarded messages';
                        else {
                            msg_text = fwd_message[0].get('message') || (fwd_message[0].get('forwarded_message').length + ' forwarded messages');
                            fwd_msg_author = user_info.nickname || fwd_message[0].get('from_jid') || user_info.id;
                        }
                    }
                    if (images) {
                        if (images.length == 1)
                            msg_text = '<span class=text-color-500>Image: </span>' + images[0].name;
                        if (images.length > 1)
                            msg_text = '<span class=text-color-500>' + images.length + ' images</span>';
                    }
                    if (files) {
                        if (files.length == 1)
                            msg_text = '<span class=text-color-500>File: </span>' + files[0].name + ' (' + files[0].size + ')';
                        if (files.length > 1)
                            msg_text = '<span class=text-color-500>' + files.length + ' files</span>';
                    }

                    let user_info = message.get('user_info') || {},
                        chat_content = this.account.chats.get(this.hash_id).item_view.content,
                        is_scrolled = chat_content.isScrolledToBottom(),
                        msg_author = user_info.nickname || message.get('from_jid') || user_info.id,
                        pinned_msg = {
                            author: msg_author,
                            time: utils.pretty_datetime(message.get('time')),
                            message: msg_text,
                            fwd_author: fwd_msg_author
                        },
                        pinned_msg_html = $(templates.group_chats.pinned_message(pinned_msg));
                    pinned_msg_elem.html(pinned_msg_html).emojify('.chat-msg-content', {emoji_size: 18});
                    var height_pinned_msg = pinned_msg_elem.height();
                    pinned_msg_elem.siblings('.chat-content').css({
                        'height': 'calc(100% - ' + height_pinned_msg + 'px)'
                    });
                    if (is_scrolled)
                        chat_content.scrollToBottom();
                    pinned_msg_elem.attr('data-msgid', message.msgid);
                }
            },

            resetStatus: function (timeout) {
                clearTimeout(this._reset_status_timeout);
                this._reset_status_timeout = setTimeout(function () {
                    this.set({
                        status_updated: moment.now(),
                        status: 'offline',
                        status_message: ''
                    });
                }.bind(this), timeout || 5000);
            },

            searchByParticipants: function (query, callback) {
                let participants_list = [];
                this.participants.forEach(function (participant) {
                    let jid = participant.get('jid');
                    // if (jid !== this.account.get('jid')) {
                        if (query) {
                            query = query.toLowerCase();
                            let nickname = participant.get('nickname'),
                                id = participant.get('id');
                            if (jid && jid.toLowerCase().indexOf(query) > -1 || /*id && id.toLowerCase().indexOf(query) > -1 ||*/ nickname && nickname.toLowerCase().indexOf(query) > -1)
                                participants_list.push(participant);
                        } else
                            participants_list.push(participant);
                    // }
                }.bind(this));
                callback && callback(participants_list);
            },

            updateName: function () {
                if (this.get('roster_name') && this.get('name') !== this.get('roster_name'))
                    this.set('name', this.get('roster_name'));
            },

            showDetails: function (screen) {
                screen || (screen = 'contacts');
                xabber.body.setScreen(screen, {right: 'contact_details', contact: this});
            }
        });

        xabber.ContactItemView = xabber.BasicView.extend({
            className: 'roster-contact list-item',

            _initialize: function (options) {
                this.account = this.model.account;
                this.$el.attr({'data-id': uuid(), 'data-jid': this.model.get('jid')});
                this.$('.jid').text(this.model.get('jid'));
                this.interval_last;
                this.updateName();
                this.updateStatus();
                this.updateAvatar();
                this.selectView();
                this.updateGroupChat();
                this.updateBot();
                this.updatePrivateChat();
                this.updateIncognitoChat();
                this.$('.bot-chat-icon').showIf(this.model.get('bot'));
                this.model.on("change:name", this.updateName, this);
                this.model.on("change:image", this.updateAvatar, this);
                this.model.on("change:status_updated", this.updateStatus, this);
                this.model.on("change:private_chat", this.updatePrivateChat, this);
                this.model.on("change:incognito_chat", this.updateIncognitoChat, this);
                this.model.on("change:bot", this.updateBot, this);
                this.model.on("change:status_message", this.updateStatusMsg, this);
                this.model.on("change:last_seen", this.lastSeenUpdated, this);
                this.model.on("change:group_chat", this.updateGroupChat, this);
            },

            updateName: function () {
                this.$('.name').text(this.model.get('name'));
            },

            updateAvatar: function () {
                this.$('.circle-avatar').setAvatar(this.model.cached_image, this.avatar_size);
            },

            updateStatus: function () {
                this.$('.status').attr('data-status', this.model.get('status'));
                var group_text = 'Group chat';
                if (this.model.get('group_info')) {
                    group_text = this.model.get('group_info').members_num;
                    if (this.model.get('group_info').members_num > 1)
                        group_text += ' participants';
                    else
                        group_text += ' participant';
                }
                this.model.get('group_chat') ? this.$('.status-message').text(group_text) : this.$('.status-message').text(this.model.getStatusMessage());
                if (this.model.get('status') == 'offline') {
                    if (!Strophe.getNodeFromJid(this.model.get('jid'))) {
                        this.model.set({status_message: 'Server'});
                        return;
                    }
                    if (this.model.get('last_seen')) {
                    var seconds = (moment.now() - this.model.get('last_seen'))/1000,
                        new_status = utils.pretty_last_seen(seconds);
                    this.model.set({ status_message: new_status });
                    }
                }
            },

            selectView: function () {
                if (this.model.get('group_chat')) {
                    this.$('.private-chat').addClass('hidden');
                    this.$('.group_chat').removeClass('hidden');
                }
            },

            lastSeenUpdated: function () {
                if ((this.model.get('status') == 'offline')&&(this.model.get('last_seen'))&&(_.isUndefined(this.interval_last))) {
                    this.interval_last = setInterval(function() {
                        var seconds = (moment.now() - this.model.get('last_seen'))/1000,
                            new_status = utils.pretty_last_seen(seconds);
                        this.model.set({ status_message: new_status });
                    }.bind(this), 60000);
                }
                else
                {
                    clearInterval(this.interval_last);
                }
            },

            updateCSS: function () {
                if (this.$el.is(':visible')) {
                    var name_width = this.$('.name-wrap').width();
                    this.model.get('muted') && (name_width -= 24);
                    this.model.get('group_chat') && (name_width -= 20);
                    this.$('.name').css('max-width', name_width);
                }
            },

            updateGroupChat: function () {
                var is_group_chat = this.model.get('group_chat');
                this.$('.status').hideIf(is_group_chat);
                (is_group_chat && !this.model.get('private_chat') && !this.model.get('incognito_chat')) && this.$('.chat-icon').showIf(true).children('img').attr({src: constants.CONTACT_ICONS.GROUP_CHAT_ICON});
                this.updateCSS();
            },

            updateBot: function () {
                this.model.get('bot') && this.$('.chat-icon').showIf(true).children('img').attr({src: constants.CONTACT_ICONS.BOT_CHAT_ICON});
            },

            updatePrivateChat: function () {
                this.model.get('private_chat') && this.$('.chat-icon').showIf(true).children('img').attr({src: constants.CONTACT_ICONS.PRIVATE_CHAT_ICON});
            },

            updateIncognitoChat: function () {
                (this.model.get('incognito_chat') && !this.model.get('private_chat')) && this.$('.chat-icon').showIf(true).children('img').attr({src: constants.CONTACT_ICONS.INCOGNITO_CHAT_ICON});
            },

            updateStatusMsg: function() {
                var group_text = 'Group chat';
                if (this.model.get('group_info')) {
                    group_text = this.model.get('group_info').members_num;
                    if (this.model.get('group_info').members_num > 1)
                        group_text += ' participants';
                    else
                        group_text += ' participant';
                }
                this.model.get('group_chat') ? this.$('.status-message').text(group_text) : this.$('.status-message').text(this.model.getStatusMessage());
            }
        });

        xabber.ContactItemRightView = xabber.ContactItemView.extend({
            template: templates.contact_right_item,
            avatar_size: constants.AVATAR_SIZES.CONTACT_RIGHT_ITEM,

            events: {
                "click": "clickOnItem",
                "mouseover": "showJid",
                "mouseleave": "hideJid",
            },

            showJid: function () {
                if (this.$('.name').text() !== this.model.get('jid')) {
                    this.$('.status-message').addClass('hidden');
                    this.$('.jid').removeClass('hidden');
                }
            },

            hideJid: function () {
                this.$('.jid').addClass('hidden');
                this.$('.status-message').removeClass('hidden');
            },

            clickOnItem: function () {
                this.model.trigger("open_chat", this.model);
            }
        });

        xabber.ContactItemLeftView = xabber.ContactItemView.extend({
            template: templates.contact_left_item,
            avatar_size: constants.AVATAR_SIZES.CONTACT_LEFT_ITEM,

            events: {
                "click": "clickOnItem"
            },

            __initialize: function () {
                this.updateDisplayStatus();
                this.updateBlockedState();
                this.updateMutedState();
                this.model.on("change:display", this.updateDisplayStatus, this);
                this.model.on("change:blocked", this.updateBlockedState, this);
                this.model.on("change:muted", this.updateMutedState, this);
                this.model.on("change:group_chat", this.updateGroupChat, this);
            },

            updateDisplayStatus: function () {
                this.$el.switchClass('active', this.model.get('display'));
            },

            updateBlockedState: function () {
                this.$el.switchClass('blocked', this.model.get('blocked'));
            },

            updateMutedState: function () {
                this.$('.muted-icon').showIf(this.model.get('muted'));
                this.updateCSS();
            },

            clickOnItem: function () {
                this.model.showDetails();
            }
        });

        xabber.ContactResources = xabber.Resources.extend({
            initialize: function (models, options) {
                this.contact = options.contact;
                this.jid = options.contact.get('jid');
                this.connection = options.contact.account.connection;
                this.on("add change", this.onResourceUpdated, this);
                this.on("remove", this.onResourceRemoved, this);
            },

            onResourceUpdated: function (resource) {
                if (resource === this.first()) {
                    this.contact.set({
                        status_updated: moment.now(),
                        status: resource.get('status'),
                        status_message: resource.get('status_message')
                    });
                }
            },

            onResourceRemoved: function (resource) {
                let attrs = {status_updated: moment.now()};
                if (this.length) {
                    attrs.status = this.first().get('status');
                    attrs.status_message = this.first().get('status_message');
                } else {
                    attrs.status = 'offline';
                    attrs.status_message = '';
                }
                this.contact.set(attrs);
            }
        });

        xabber.ContactResourcesView = xabber.ResourcesView.extend({
            onResourceRemoved: function (resource) {
                this.removeChild(resource.get('resource'));
                this.$el.showIf(this.model.length);
                this.parent.updateScrollBar();
            },

            onReset: function () {
                this.removeChildren();
                this.$el.addClass('hidden');
                this.parent.updateScrollBar();
            },

            updatePosition: function (resource) {
                var view = this.child(resource.get('resource'));
                if (!view) return;
                view.$el.detach();
                var index = this.model.indexOf(resource);
                if (index === 0) {
                    this.$('.resources-wrap').prepend(view.$el);
                } else {
                    this.$('.resource-wrap').eq(index - 1).after(view.$el);
                }
                this.updateScrollBar();
            }
        });

        xabber.ContactVCardView = xabber.VCardView.extend({
            events: {
                "click .btn-vcard-refresh": "refresh",
                "click .details-icon": "onClickIcon"
            }
        });

        xabber.ContactDetailsView = xabber.BasicView.extend({
            className: 'details-panel contact-details-panel',
            template: templates.contact_details,
            ps_selector: '.panel-content-wrap',
            avatar_size: constants.AVATAR_SIZES.CONTACT_DETAILS,

            events: {
                "click .btn-escape": "openChat",
                "click .btn-chat": "openChat",
                "click .btn-voice-call": "voiceCall",
                "click .btn-video-call": "videoCall",
                "click .btn-add": "addContact",
                "click .btn-delete": "deleteContact",
                "click .btn-block": "blockContact",
                "click .btn-unblock": "unblockContact",
                "click .btn-mute": "changeNotifications",
                "click .btn-auth-request": "requestAuthorization"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.name_field = new xabber.ContactNameWidget({
                    el: this.$('.name-wrap')[0],
                    model: this.model
                });
                this.resources_view = this.addChild('resources',
                    xabber.ContactResourcesView, {model: this.model.resources,
                        el: this.$('.resources-block-wrap')[0]});
                this.vcard_view = this.addChild('vcard', xabber.ContactVCardView,
                    {model: this.model, el: this.$('.vcard')[0]});
                this.edit_groups_view = this.addChild('groups',
                    xabber.ContactEditGroupsView, {el: this.$('.groups-block-wrap')[0]});
                this.updateName();
                this.updateStatus();
                this.updateAvatar();
                this.updateButtons();
                this.model.on("change", this.update, this);
            },

            render: function (options) {
                if (!this.model.get('vcard_updated')) {
                    this.vcard_view.refresh();
                }
                let dropdown_settings = {
                    inDuration: 100,
                    outDuration: 100,
                    constrainWidth: false,
                    hover: false,
                    alignment: 'right'
                };
                this.$('.main-info .dropdown-button').dropdown(dropdown_settings);
                this.updateName();
            },

            onChangedVisibility: function () {
                this.model.set('display', this.isVisible());
            },

            update: function () {
                var changed = this.model.changed;
                if (_.has(changed, 'name')) this.updateName();
                if (_.has(changed, 'image')) this.updateAvatar();
                if (_.has(changed, 'status_updated')) this.updateStatus();
                if (_.has(changed, 'muted')) this.updateNotifications();
                if (_.has(changed, 'status_message')) this.updateStatusMsg();
                if (_.has(changed, 'in_roster') || _.has(changed, 'blocked') ||
                    _.has(changed, 'subscription')) {
                    this.updateButtons();
                }
            },

            updateName: function () {
                this.$('.main-info .contact-name').text(this.model.get('name'));
                if (this.model.get('name') != this.model.get('roster_name'))
                    this.$('.main-info .contact-name').addClass('name-is-custom');
                else
                    this.$('.main-info .contact-name').removeClass('name-is-custom');
            },

            updateStatus: function () {
                this.$('.status').attr('data-status', this.model.get('status'));
                this.$('.status-message').text(this.model.getStatusMessage());
            },

            updateStatusMsg: function () {
                this.$('.status-message').text(this.model.getStatusMessage());
            },

            updateAvatar: function () {
                var image = this.model.cached_image;
                this.$('.circle-avatar').setAvatar(image, this.avatar_size);
            },

            updateButtons: function () {
                var in_roster = this.model.get('in_roster'),
                    is_blocked = this.model.get('blocked'),
                    is_server = this.model.get('is_server'),
                    subscription = this.model.get('subscription');
                this.$('.btn-add').hideIf(in_roster);
                this.$('.btn-delete').showIf(in_roster);
                this.$('.btn-block').hideIf(is_blocked);
                this.$('.btn-unblock').showIf(is_blocked);
                this.$('.btn-auth-request').showIf(!is_server && in_roster && !is_blocked &&
                    subscription !== 'both' && subscription !== 'to');
            },

            updateNotifications: function () {
                this.$('.btn-mute').switchClass('mdi-bell-off', this.model.get('muted'));
                this.$('.btn-mute').switchClass('mdi-bell', !this.model.get('muted'));
            },

            openChat: function () {
                this.model.trigger("open_chat", this.model);
            },

            voiceCall: function () {
                this.initCall();
            },

            videoCall: function () {
                this.initCall({video: true});

            },

            initCall: function (type) {
                this.openChat();
                let chat = this.account.chats.getChat(this.model);
                chat.item_view.content.initJingleMessage(type);
            },

            changeNotifications: function () {
                var muted = !this.model.get('muted');
                this.model.set('muted', muted);
                this.account.chat_settings.updateMutedList(this.model.get('jid'), muted);
            },

            addContact: function () {
                xabber.add_contact_view.show({account: this.account, jid: this.model.get('jid')});
            },

            deleteContact: function (ev) {
                var contact = this.model;
                utils.dialogs.ask("Delete contact", "Do you want to delete "+
                    contact.get('name')+" from contacts?", null, { ok_button_text: 'delete'}).done(function (result) {
                    if (result) {
                        contact.removeFromRoster();
                        contact.trigger('archive_chat');
                        xabber.trigger("clear_search");
                    }
                });
            },

            blockContact: function () {
                var contact = this.model;
                utils.dialogs.ask("Block contact", "Do you want to block "+
                    contact.get('name')+"?", null, { ok_button_text: 'block'}).done(function (result) {
                    if (result) {
                        contact.blockRequest();
                        xabber.trigger("clear_search");
                    }
                });
            },

            unblockContact: function () {
                var contact = this.model;
                utils.dialogs.ask("Unblock contact", "Do you want to unblock "+
                    contact.get('name')+"?", null, { ok_button_text: 'unblock'}).done(function (result) {
                    if (result) {
                        contact.unblock();
                        xabber.trigger("clear_search");
                    }
                });
            },

            requestAuthorization: function () {
                this.model.pres('subscribe');
                this.openChat();
            }
        });

        xabber.GroupChatDetailsView = xabber.BasicView.extend({
            className: 'details-panel groupchat-details-panel',
            template: templates.group_chats.group_chat_details,
            ps_selector: '.panel-content-wrap',
            avatar_size: constants.AVATAR_SIZES.CONTACT_DETAILS,
            member_avatar_size: constants.AVATAR_SIZES.GROUPCHAT_MEMBER_ITEM,

            events: {
                "click .btn-join": "joinChat",
                "click .btn-delete": "deleteContact",
                "click .btn-block": "blockContact",
                "click .btn-unblock": "unblockContact",
                "click .btn-leave": "leaveGroupChat",
                "click .btn-invite": "inviteUser",
                "click .btn-settings": "editProperties",
                "click .btn-default-restrictions": "editDefaultRestrictions",
                "click .btn-chat": "openChat",
                "click .btn-escape": "openChat",
                "click .btn-clear-history": "retractAllMessages",
                "change .circle-avatar input": "changeAvatar",
                "click .list-variant": "changeList"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.name_field = new xabber.ContactNameWidget({
                    el: this.$('.name-wrap')[0],
                    model: this.model
                });
                this.participants = this.addChild('participants', xabber.ParticipantsView, {model: this.model, el: this.$('.participants-wrap')[0]});
                this.edit_groups_view = this.addChild('groups',
                    xabber.ContactEditGroupsView, {el: this.$('.groups-block-wrap')[0]});
                this.group_chat_properties = this.addChild('properties_view', xabber.GroupChatPropertiesView, {model:this.model, el: this.$('.group-chat-properties-wrap')[0]});
                this.group_chat_properties_edit = new xabber.GroupChatPropertiesEditView({model: this.model});
                this.default_restrictions_edit = new xabber.DefaultRestrictionsView({model: this.model});
                this.model.my_rights = this.model.my_rights || {permissions: [], restrictions: []};
                this.updateName();
                this.updateStatus();
                this.updateAvatar();
                this.updateColorScheme();
                this.account.settings.on("change:color", this.updateColorScheme, this);
                this.model.on("change", this.update, this);
                this.model.on("permissions_changed", this.updateButtons, this);
            },

            render: function (options) {
                this.updateName();
                this.updateButtons();
                this.$('.btn-delete').showIf(this.model.get('subscription') === "both");
                this.$('.btn-join').showIf(this.model.get('subscription') !== "both");
                let dropdown_settings = {
                    inDuration: 100,
                    outDuration: 100,
                    constrainWidth: false,
                    hover: false,
                    alignment: 'right'
                };
                this.$('.select-users-list-wrap .dropdown-button').dropdown(dropdown_settings);
                this.$('.main-info .dropdown-button').dropdown(dropdown_settings);
                this.updateList('participants');
                return this;
            },

            update: function () {
                var changed = this.model.changed;
                if (_.has(changed, 'name')) this.updateName();
                if (_.has(changed, 'image')) this.updateAvatar();
                if (_.has(changed, 'status_updated')) this.updateStatus();
                if (_.has(changed, 'status_message')) this.updateStatusMsg();
            },

            updateColorScheme: function () {
                this.$el.attr('data-color', this.account.settings.get('color'));
            },

            updateButtons: function () {
                let has_permission = this.model.my_info && this.model.my_info.get('permissions').find(permission => (permission.name == 'owner' || permission.name == 'administrator')),
                    is_blocked = this.model.get('blocked');
                this.$('.btn-settings-wrap').switchClass('non-active', !has_permission);
                this.$('.btn-default-restrictions-wrap').switchClass('non-active', !has_permission);
                this.$('.btn-invite-wrap').switchClass('non-active', this.model.get('private_chat'));
                this.$('.btn-block').hideIf(is_blocked);
                this.$('.btn-unblock').showIf(is_blocked);
            },

            updateName: function () {
                this.$('.main-info .contact-name').text(this.model.get('name'));
                if (this.model.get('name') != this.model.get('roster_name'))
                    this.$('.main-info .contact-name').addClass('name-is-custom');
                else
                    this.$('.main-info .contact-name').removeClass('name-is-custom');
            },

            joinChat: function () {
                this.model.invitation.joinGroupChat();
            },

            editProperties: function (ev) {
                if (!$(ev.target).closest('.button-wrap').hasClass('non-active'))
                    this.group_chat_properties_edit.open();
            },

            editDefaultRestrictions: function (ev) {
                if (!$(ev.target).closest('.button-wrap').hasClass('non-active'))
                    this.default_restrictions_edit.open();
            },

            leaveGroupChat: function (ev) {
                var contact = this.model;
                utils.dialogs.ask("Leave groupchat", "Do you want to leave groupchat "+
                    contact.get('name')+"?", null, { ok_button_text: 'leave'}).done(function (result) {
                    if (result) {
                        contact.declineSubscription();
                        contact.removeFromRoster();
                        contact.set('in_roster', false);
                        xabber.trigger("clear_search");
                        this.openChat();
                    }
                }.bind(this));
            },

            inviteUser: function (ev) {
                if (!$(ev.target).closest('.button-wrap').hasClass('non-active'))
                    xabber.invite_panel.open(this.account, this.model);
            },

            changeList: function (ev) {
                let $target = $(ev.target),
                    list_name = $target.data('value');
                this.updateList(list_name);
            },

            updateList: function (name) {
                let view = this.child(name);
                !view && (view = this.addList(name));
                this.$('.panel-footer').showIf(name == 'settings');
                view && this.$('.select-users-list-wrap .dropdown-button .list-value').data('value', name).text(utils.pretty_name(name)) && view._render();
            },

            addList: function (name) {
                let constructor_func;
                switch (name) {
                    case 'blocked':
                        constructor_func = xabber.BlockedView;
                        break;
                    case 'invitations':
                        constructor_func = xabber.InvitationsView;
                        break;
                };
                if (constructor_func)
                    return this.addChild(name, constructor_func, {model: this.model, el: this.$('.participants-wrap')[0]});
                else
                    return;
            },

            deleteContact: function (ev) {
                var contact = this.model;
                utils.dialogs.ask("Delete contact", "Do you want to delete "+
                    contact.get('name')+" from contacts?", null, { ok_button_text: 'delete'}).done(function (result) {
                    if (result) {
                        contact.removeFromRoster();
                        contact.trigger('archive_chat');
                        xabber.trigger("clear_search");
                    }
                });
            },

            blockContact: function () {
                var contact = this.model;
                utils.dialogs.ask("Block group chat", "Do you want to block "+
                    contact.get('name')+"?", null, { ok_button_text: 'block'}).done(function (result) {
                    if (result) {
                        contact.blockRequest();
                        xabber.trigger("clear_search");
                    }
                });
            },

            unblockContact: function () {
                var contact = this.model;
                utils.dialogs.ask("Unblock contact", "Do you want to unblock "+
                    contact.get('name')+"?", null, { ok_button_text: 'unblock'}).done(function (result) {
                    if (result) {
                        contact.unblock();
                        xabber.trigger("clear_search");
                    }
                });
            },

            updateStatus: function () {
                this.$('.status').attr('data-status', this.model.get('status'));
                this.$('.status-message').text(this.model.getStatusMessage());
            },

            updateStatusMsg: function () {
                var group_text = 'Group chat';
                if (this.model.get('group_info')) {
                    group_text = this.model.get('group_info').members_num;
                    if (this.model.get('group_info').members_num > 1)
                        group_text += ' participants';
                    else
                        group_text += ' participant';
                    group_text += ', ' + (this.model.get('group_info').online_members_num) + ' online';
                }
                this.$('.status-message').text(group_text);
            },

            updateAvatar: function () {
                let image = this.model.cached_image;
                this.$('.main-info .circle-avatar').setAvatar(image, this.avatar_size);
            },

            openChat: function () {
                this.model.trigger("open_chat", this.model);
            },

            changeAvatar: function (ev) {
                var field = ev.target;
                if (!field.files.length) {
                    return;
                }
                $(field).siblings('.preloader-wrap').addClass('visible').find('.preloader-wrapper').addClass('active');
                var file = field.files[0];
                field.value = '';
                if (file.size > constants.MAX_AVATAR_FILE_SIZE) {
                    utils.dialogs.error('File is too large');
                } else if (!file.type.startsWith('image')) {
                    utils.dialogs.error('Wrong image');
                }

                utils.images.getAvatarFromFile(file).done(function (image) {
                    if (image) {
                        file.base64 = image;
                        this.model.pubAvatar(file, "", function () {
                            $(field).siblings('.preloader-wrap').removeClass('visible').find('.preloader-wrapper').removeClass('active');
                        }, function (error) {
                            $(field).siblings('.preloader-wrap').removeClass('visible').find('.preloader-wrapper').removeClass('active');
                            let error_text = $(error).find('text').text() || 'You have no permissions to change avatar';
                            utils.dialogs.error(error_text);
                        });
                    }
                }.bind(this));
            },

            retractAllMessages: function () {
                var group_chat = this.account.chats.getChat(this.model);
                utils.dialogs.ask("Clear message archive", "Do you want to delete all messages from archive?", null, { ok_button_text: 'delete'}).done(function (result) {
                    if (result) {
                        group_chat.retractAllMessages(true);
                    }
                }.bind(this));
            }
        });

        xabber.GroupChatPropertiesView = xabber.BasicView.extend({
            template: templates.group_chats.group_chat_properties,

            events: {
                "click .group-chat-properties .details-icon": "onClickIcon"
            },

            _initialize: function () {
                this.$el.html(this.template());
                this.contact = this.model;
                this.account = this.model.account;
                this.model.on("change:name", this.updateName, this);
                this.model.on("change:group_info", this.update, this);
            },

            render: function () {
                this.update();
            },

            update: function () {
                let info = this.model.get('group_info') || {};
                this.$('.jabber-id .value').text(info.jid);
                this.$('.name .value').text(info.name);
                this.$('.description .value').text(info.description);
                this.$('.model .value').text(utils.pretty_name(info.model));
                this.$('.anonymous .value').text((info.anonymous === 'incognito') ? 'Yes' : 'No');
                this.$('.searchable .value').text((info.searchable === 'none') ? 'No' : utils.pretty_name(info.searchable));
                this.$('.name-info-wrap').switchClass('hidden', !info.name);
                this.$('.description-info-wrap').switchClass('hidden', !info.description);
                this.$('.model-info-wrap').switchClass('hidden', !info.model);
                this.$('.anonymous-info-wrap').switchClass('hidden', !info.anonymous);
                this.$('.searchable-info-wrap').switchClass('hidden', !info.searchable);
            },

            onClickIcon: function (ev) {
                let $target_info = $(ev.target).closest('.info-wrap'),
                    $target_value = $target_info.find('.value'), copied_text = "";
                $target_value.each(function (idx, item) {
                    let $item = $(item),
                        value_text = $item.text();
                    if ($target_info.hasClass('anonymous-info-wrap') || $target_info.hasClass('searchable-info-wrap')) {
                        let label_name = $target_info.find('.label').first().text();
                        if (value_text === 'No')
                            value_text += ' ' + label_name.toLowerCase();
                        else
                            if (value_text === 'Yes')
                                value_text = label_name;
                    }
                    value_text && (copied_text != "") && (copied_text += '\n');
                    value_text && (copied_text += value_text);
                    copied_text && utils.copyTextToClipboard(copied_text, 'Copied in clipboard', 'ERROR: Not copied in clipboard');
                }.bind(this));
            }
        });

        xabber.GroupChatPropertiesEditView = xabber.BasicView.extend({
            className: 'modal dialog-modal group-chat-properties-edit',
            template: templates.group_chats.group_chat_properties_edit,

            events: {
                "click .btn-save": "saveChanges",
                "click .btn-cancel": "close",
                "change input": "updateSaveButton",
                "keyup .property-wrap .text-field": "updateSaveButton"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.contact = this.model;
                this.$el.html(this.template());
                this.model.on("change:name", this.updateName, this);
                this.model.on("change:group_info", this.update, this);
            },

            open: function () {
                this.$el.openModal({
                    ready: function () {
                        this.update();
                        this.$('.modal-content').css('height', this.$el.height() - 115).perfectScrollbar({theme: 'item-list'});
                        this.updateScrollBar();
                    }.bind(this),
                    complete: function () {
                        this.update();
                        this.$el.detach();
                        this.$('.modal-content').css('height', '100%');
                        this.data.set('visible', false);
                    }.bind(this)
                });
            },

            close: function () {
                this.$el.closeModal({
                    complete: function () {
                        this.update();
                        this.hide.bind(this);
                    }.bind(this)
                });
            },

            updateName: function () {
                this.$('.name-info-wrap').find('.name').find('.value').text(this.model.get('name'));
            },

            update: function () {
                this.$('button').blur();
                let info = this.model.get('group_info') || {};
                this.$('.jid-info-wrap .jabber-id').find('.value').text(info.jid);
                this.$('p[id="anonymous-' + info.anonymous + '"]').removeClass('hidden');
                this.$('.name-field #new_name_value').val(info.name);
                this.$('.description-field textarea').val(info.description);
                this.$('.global-field input[id="indexation-' + info.searchable +'"]').prop('checked', true);
                this.$('.membership-field input[id="membership-' + info.model +'"]').prop('checked', true);
            },

            saveChanges: function() {
                if (this.$('.btn-save').hasClass('non-active'))
                    return;
                let new_name = this.$('input[name=chat_name]').val(),
                    new_searchable = this.$('.global-field input:checked').attr('id').substr(11),
                    new_description = this.$('.description-field textarea').val(),
                    new_model = this.$('.membership-field input:checked').attr('id').substr(11),
                    info = this.contact.get('group_info') || {}, has_changes = false,
                    iq = $iq({from: this.account.get('jid'), type: 'set', to: this.contact.get('jid')})
                        .c('update', {xmlns: Strophe.NS.GROUP_CHAT});
                if (info.name != new_name) {
                    has_changes = true;
                    iq.c('name').t(new_name).up();
                }
                if (info.description != new_description) {
                    has_changes = true;
                    iq.c('description').t(new_description).up();
                }
                if (info.searchable != new_searchable) {
                    has_changes = true;
                    iq.c('index').t(new_searchable).up();
                }
                if (info.model != new_model) {
                    has_changes = true;
                    iq.c('membership').t(new_model).up();
                }
                if (has_changes)
                    this.account.sendIQ(iq, function () {
                        this.$('button').addClass('non-active');
                    }.bind(this), function (error) {
                        this.$('button').addClass('non-active');
                        let err_text = $(error).find('error text').text() || 'You have no permission to change chat properties';
                        this.close();
                        utils.dialogs.error(err_text);
                    }.bind(this));
                else
                    this.$('button').removeClass('non-active');
            },

            updateSaveButton: function () {
                let new_name = this.$('input[name=chat_name]').val(),
                    new_searchable = this.$('.global-field input:checked').attr('id').substr(11),
                    new_description = this.$('.description-field textarea').val(),
                    new_model = this.$('.membership-field input:checked').attr('id').substr(11),
                    info = this.contact.get('group_info') || {}, has_changes = false;
                (info.name != new_name) && (has_changes = true);
                (info.description != new_description) && (has_changes = true);
                (info.searchable != new_searchable) && (has_changes = true);
                (info.model != new_model) && (has_changes = true);
                this.$('.btn-save').switchClass('non-active', !has_changes);
            }

        });

        xabber.InvitationsView = xabber.BasicView.extend({
            events: {
                "click .revoke-invitation": "revokeInvitation"
            },
            status: 'invitations',
            member_avatar_size: constants.AVATAR_SIZES.GROUPCHAT_MEMBER_ITEM,

            _initialize: function (options) {
                this.contact = options.model;
                this.account = this.contact.account;
                this.$error = $('<p class="errors"/>');
                this.$current_list = this.$el.prev().find('.dropdown-button .list-value');
            },

            _render: function () {
                this.$el.html($(templates.preloader()));
                this.getInvitations();
            },

            getInvitations: function () {
                let iq = $iq({
                    from: this.account.get('jid'),
                    type: 'get',
                    to: this.contact.get('jid')})
                    .c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#invite'});

                this.account.sendIQ(iq, function (response) {
                    if (this.$current_list.data('value') === this.status) {
                        this.$el.html("");
                        $(response).find('query').find('user').each(function (idx, item) {
                            let user = {jid: $(item).attr('jid'), status: this.status},
                                $item_view = $(templates.group_chats.invited_member_item(user)),
                                avatar = Images.getDefaultAvatar(user.jid);
                            this.$el.append($item_view);
                            $item_view.find('.circle-avatar').setAvatar(avatar, this.member_avatar_size);
                        }.bind(this));
                        if (!$(response).find('query').find('user').length)
                            this.$el.html(this.$error.text('No pending invitations'));
                    }
                    }.bind(this),
                    function(err) {
                        if (this.$current_list.data('value') === this.status)
                            this.$el.html(this.$error.text($(err).find('text').text() || 'You nave no permission to see invitations list'));
                    }.bind(this));
            },

            revokeInvitation: function (ev) {
                let $member_item = $(ev.target).closest('.invitations-user'),
                    member_jid = $member_item.data('jid'),
                    iq = $iq({from: this.account.get('jid'), to: this.contact.get('jid'), type: 'set'})
                        .c('revoke', {xmlns: Strophe.NS.GROUP_CHAT + '#invite'})
                        .c('jid').t(member_jid);
                this.account.sendIQ(iq, function () {
                    $member_item.remove();
                    !this.$el.children().length && this.$el.html(this.$error.text('No pending invitations'));
                }.bind(this));
            }
        });

        xabber.BlockedView = xabber.BasicView.extend({
            events: {
                "click .unblock-user": "unblockUser"
            },
            status: 'blocked',
            member_avatar_size: constants.AVATAR_SIZES.GROUPCHAT_MEMBER_ITEM,

            _initialize: function (options) {
                this.contact = options.model;
                this.account = this.contact.account;
                this.$error = $('<p class="errors"/>');
                this.$current_list = this.$el.prev().find('.dropdown-button .list-value');
            },

            _render: function () {
                this.$el.html($(templates.preloader()));
                this.getBlockedParticipants();
            },

            getBlockedParticipants: function () {
                let iq = $iq({
                    from: this.account.get('jid'),
                    type: 'get',
                    to: this.contact.get('jid')})
                    .c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#block'});
                this.account.sendIQ(iq, function (response) {
                   if (this.$current_list.data('value') === this.status) {
                        $(response).find('query').find('user').each(function (idx, item) {
                            this.$el.html("");
                            let user = {jid: $(item).attr('jid'), status: this.status},
                                $item_view = $(templates.group_chats.invited_member_item(user)),
                                avatar = Images.getDefaultAvatar(user.jid);
                            this.$el.append($item_view);
                            $item_view.find('.circle-avatar').setAvatar(avatar, this.member_avatar_size);
                        }.bind(this));
                        if (!$(response).find('query').find('user').length)
                            this.$el.html(this.$error.text('Block list is empty'));
                    }
                    }.bind(this),
                    function(err) {
                        if (this.$current_list.data('value') === this.status)
                            this.$el.html(this.$error.text($(err).find('text').text() || 'You nave no permission to see blocked list'));
                    }.bind(this));
            },

            unblockUser: function (ev) {
                var $member_item = $(ev.target).closest('.blocked-user'),
                    member_jid = $member_item.data('jid'),
                    iq = $iq({from: this.account.get('jid'), type: 'set', to: this.contact.get('jid') })
                        .c('unblock', {xmlns: Strophe.NS.GROUP_CHAT + '#block' })
                        .c('jid').t(member_jid);
                this.account.sendIQ(iq, function () {
                    $member_item.remove();
                    !this.$el.children().length && this.$el.html(this.$error.text('Block list is empty'));
                }.bind(this));
            }
        });

        xabber.ParticipantsView = xabber.BasicView.extend({
            className: 'overflow-visible',
            ps_selector: '.members-list-wrap',
            ps_settings: {theme: 'item-list'},
            template: templates.group_chats.participants,
            member_avatar_size: constants.AVATAR_SIZES.GROUPCHAT_MEMBER_ITEM,

            events: {
                "click .group-chat-participant": "showParticipantProperties",
                "keyup .participants-search-form" : "keyUpSearch",
                "click .close-search-icon": "clearSearch",
                "mouseover .group-chat-participant": "showJid",
                "mouseleave .group-chat-participant": "hideJid"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.participants = this.model.participants;
                this.model.on("update_participants", this.updateParticipants, this);
                this.$(this.ps_selector).perfectScrollbar(this.ps_settings);
            },

            _render: function () {
                this.$el.html(this.template()).addClass('request-waiting');
                this.participant_properties_panel = new xabber.ParticipantPropertiesView({model: this});
                this.updateParticipants();
                this.$('.members-list-wrap').perfectScrollbar({theme: 'item-list'});
                if (!this.model.all_rights)
                    this.model.getAllRights();
                return this;
            },

            updateParticipants: function () {
                this.participantsRequest(function (version) {
                    if (this.model.get('group_info') && this.participants.length != this.model.get('group_info').members_num) {
                        this.account.groupchat_settings.resetParticipantsList(this.model.get('jid'));
                        this.participants.resetParticipants();
                        this.updateParticipants();
                        return;
                    }
                    version && this.account.groupchat_settings.setParticipantsListVersion(this.model.get('jid'), version);
                    (this.participants.version < version) && this.participants.updateVersion();
                    this.participants.each(function (participant) {
                        this.renderMemberItem(participant);
                    }.bind(this));
                    this.$el.removeClass('request-waiting');
                }.bind(this));
            },

            participantsRequest: function (callback) {
                this.model.membersRequest({version: this.participants.version }, function (response) {
                    let $response = $(response),
                        version = $response.find('query').attr('version');
                    $response.find('query item').each(function (idx, item) {
                        let $item = $(item),
                            subscription = $item.find('subscription').text(),
                            id = $item.find('id').text();
                        if (subscription === 'none') {
                            this.participants.get(id) && this.participants.get(id).destroy();
                            this.account.groupchat_settings.removeParticipantFromList(this.model.get('jid'), id);
                        }
                        else
                            this.participants.createFromStanza($item);
                    }.bind(this));
                    callback && callback(version);
                }.bind(this));
            },

            renderMemberItem: function (participant) {
                let attrs = _.clone(participant.attributes);
                attrs.nickname = _.escape(attrs.nickname);
                attrs.badge = _.escape(attrs.badge);
                let $item_view = $(templates.group_chats.group_member_item(attrs)),
                    view = this.$('.members-list-wrap .list-item[data-id="' + attrs.id + '"]');
                $item_view.emojify('.badge', {emoji_size: 14});
                if (view.length) {
                    view.hasClass('active') && $item_view.addClass('active');
                    if (attrs.jid == this.account.get('jid'))
                        $item_view.find('.last-seen.one-line').html($item_view.find('.last-seen.one-line').text() + '<span class="myself-participant-item text-color-700">(this is you)</span>');
                    $item_view.insertBefore(view);
                    view.detach();
                }
                else {
                    if (attrs.jid == this.account.get('jid')) {
                        $item_view.prependTo(this.$('.members-list-wrap .owners'));
                        $item_view.find('.last-seen.one-line').html($item_view.find('.last-seen.one-line').text() + '<span class="myself-participant-item text-color-700">(this is you)</span>');
                    }
                    else
                        $item_view.appendTo(this.$('.members-list-wrap .'+ attrs.role.toLowerCase() + 's'));
                }
                this.updateMemberAvatar(attrs);
            },

            updateMemberAvatar: function (member) {
                let image = Images.getDefaultAvatar(member.nickname || member.jid || member.id);
                var $avatar = (member.id) ? this.$('.list-item[data-id="'+ member.id +'"] .circle-avatar') : this.$('.list-item[data-jid="'+ member.jid +'"] .circle-avatar');
                $avatar.setAvatar(image, this.member_avatar_size);
                if (member.avatar) {
                    let cached_avatar = this.account.chat_settings.getB64Avatar(member.id);
                    if (this.account.chat_settings.getHashAvatar(member.id) == member.avatar && cached_avatar) {
                        $avatar.setAvatar(cached_avatar, this.member_avatar_size);
                    }
                    else {
                        var node = Strophe.NS.PUBSUB_AVATAR_DATA + '#' + member.id;
                        this.model.getAvatar(member.avatar, node, function (avatar) {
                            this.account.chat_settings.updateCachedAvatars(member.id, member.avatar, avatar);
                            this.$('.list-item[data-id="'+ member.id +'"] .circle-avatar').setAvatar(avatar, this.member_avatar_size);
                            if (this.account.get('jid') === member.jid) {
                                this.model.my_info.set('b64_avatar', avatar);
                                this.model.trigger('update_my_info');
                            }
                        }.bind(this));
                    }
                }
            },

            showParticipantProperties: function (ev) {
                    var participant_item = $(ev.target).closest('.group-chat-participant'),
                        participant_id = participant_item.attr('data-id'),
                        participant = this.model.participants.get(participant_id);
                    if (participant)
                        this.participant_properties_panel.open(participant);
                    else
                        this.membersRequest({id: participant_id}, function (response) {
                            let $item = $($(response).find('query item'));
                            $item.length && this.model.participants && (participant = this.model.participants.createFromStanza($item));
                            this.participant_properties_panel.open(participant);
                        }.bind(this));
            },

            showJid: function (ev) {
                var $target_item = $(ev.target).closest('.group-chat-participant');
                $target_item.find('.last-seen.one-line').addClass('hidden');
                $target_item.find('.jid.one-line').removeClass('hidden');
                $target_item.find('.id.one-line').removeClass('hidden');
            },

            hideJid: function (ev) {
                var $target_item = $(ev.target).closest('.group-chat-participant');
                $target_item.find('.jid.one-line').addClass('hidden');
                $target_item.find('.id.one-line').addClass('hidden');
                $target_item.find('.last-seen.one-line').removeClass('hidden');
            },

            keyUpSearch: function (ev) {
                if (ev.keyCode === constants.KEY_ESCAPE)
                    this.clearSearch(ev);
                else
                    this.searchParticipant();
            },

            searchParticipant: function () {
                let query = this.$('.participants-search-form input').val().toLowerCase();
                this.$('.members-list-wrap .group-chat-participant').each(function (idx, item) {
                    let $this = $(item),
                        participant_id = $this.data('id'),
                        participant = this.model.participants.find(participant => participant.get('id') === participant_id);
                    if (!participant) return;
                    var jid = participant.get('jid').toLowerCase(),
                        name = participant.get('nickname').toLowerCase();
                    $this.hideIf(name.indexOf(query) < 0 && jid.indexOf(query) < 0);
                }.bind(this));
                if (query)
                    this.$('.close-search-icon').show();
                else
                    this.$('.close-search-icon').hide();
            },

            clearSearch: function (ev) {
                if (ev)
                    ev && ev.preventDefault();
                this.$('.search-input').val('');
                this.searchParticipant();
            }
        });

        xabber.ParticipantPropertiesView = xabber.BasicView.extend({
            className: 'modal dialog-modal edit-rights',
            template: templates.group_chats.participant_rights,
            member_details_avatar_size: constants.AVATAR_SIZES.PARTICIPANT_DETAILS_ITEM,
            ps_selector: '.modal-content',
            ps_settings: {theme: 'item-list'},

            events: {
                "click .btn-cancel-changes": "close",
                "click .clickable-field input": "changeRights",
                "click .btn-save-user-rights": "saveRights",
                "click .nickname": "editNickname",
                "change .circle-avatar input": "changeAvatar",
                "click .btn-block-participant": "blockParticipant",
                "click .btn-set-badge": "editBadge",
                "click .btn-participant-messages": "getParticipantMessages",
                "click .btn-chat": "getPrivateChat",
                "click .property-variant": "changeTimerValue",
                "keydown .rich-textarea": "checkKeydown",
                "keyup .rich-textarea": "checkKeyup"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.contact = this.model.model;
            },

            open: function (participant) {
                this.participant = participant;
                this.render();
                this.$el.openModal({
                    ready: function () {
                        this.$el.css('height', "");
                        if (($(window).height() * 0.1 + this.$el.height()) > $(window).height())
                            this.$el.css('height', $(window).height() * 0.9);
                        this.$('.modal-content').css('max-height', 'calc(100% - ' + (56 + this.$('.header').height()) + 'px)');
                        this.scrollToTop();
                        this.updateSaveButton();
                        let dropdown_settings = {
                            inDuration: 100,
                            outDuration: 100,
                            constrainWidth: false,
                            hover: false,
                            alignment: 'left'
                        };
                        this.$('.select-timer .dropdown-button').dropdown(dropdown_settings);
                    }.bind(this),
                    complete: function () {
                        this.render();
                        this.$el.detach();
                        this.data.set('visible', false);
                    }.bind(this)
                });
            },

            close: function () {
                this.$el.closeModal({
                    complete: function () {
                        this.render();
                        this.$el.detach();
                        this.data.set('visible', false);
                    }.bind(this)
                });
            },

            render: function () {
                this.new_avatar = "";
                let attrs = _.clone(this.participant.attributes);
                attrs.nickname = _.escape(attrs.nickname);
                attrs.badge = _.escape(attrs.badge);
                attrs.is_myself = attrs.jid === this.account.get('jid');
                attrs.incognito_chat = (this.contact.get('group_info') && this.contact.get('group_info').anonymous === 'incognito') ? true : false;
                let $member_info_view;
                if (this.contact.get('private_chat')) {
                    this.$el.addClass('edit-rights-private');
                    $member_info_view = $(templates.group_chats.private_participant_details(attrs));
                }
                else
                    $member_info_view = $(templates.group_chats.participant_details_item(attrs));
                this.$('.header').html($member_info_view);
                this.$('.btn-chat-wrap').switchClass('non-active', this.participant.get('jid') === this.account.get('jid'));
                this.updateMemberAvatar(this.participant);
                this.participant_messages = [];
                this.actual_rights = [];
                if (!this.contact.get('private_chat')) {
                    this.renderAllRights();
                    this.setActualRights();
                }
                else {
                    this.$('.modal-content').addClass('hidden');
                    this.$('.modal-footer').switchClass('hidden', this.participant.get('jid') !== this.account.get('jid'));
                }
                this.updateScrollBar();
                this.$('.participant-info #edit-nickname').on("focusout", function () {
                    let new_nickname = this.$('#edit-nickname').getTextFromRichTextarea().trim();
                    if (new_nickname === "")
                        new_nickname = this.participant.get('nickname');
                    this.$('.participant-info #edit-nickname').hide();
                    this.$('.participant-info .nickname').show();
                    this.updateNickname(new_nickname);
                }.bind(this));
                this.$('.content').perfectScrollbar({theme: 'item-list'});
            },

            updateMemberAvatar: function (member) {
                let participant_id = member.get('id'),
                    $avatar = this.$('.participant-details-item[data-id="'+ participant_id +'"] .circle-avatar');
                member.image = Images.getDefaultAvatar(member.get('nickname') || member.get('jid') || participant_id);
                $avatar.setAvatar(member.image, this.member_details_avatar_size);
                this.$('.participant-details-item[data-id="'+ member.id +'"]').emojify('.badge', {emoji_size: 18});
                if (member.get('avatar')) {
                    if (this.account.chat_settings.getHashAvatar(participant_id) == member.get('avatar') && (this.account.chat_settings.getB64Avatar(participant_id))) {
                        $avatar.setAvatar(this.account.chat_settings.getB64Avatar(participant_id), this.member_details_avatar_size);
                    }
                    else {
                        let node = Strophe.NS.PUBSUB_AVATAR_DATA + '#' + participant_id;
                        this.contact.getAvatar(member.avatar, node, function (avatar) {
                            this.$('.participant-details-item[data-id="'+ participant_id +'"] .circle-avatar').setAvatar(avatar, this.member_details_avatar_size);
                        }.bind(this));
                    }
                }
                else {
                    if (this.account.chat_settings.getHashAvatar(participant_id))
                        $avatar.setAvatar(this.account.chat_settings.getB64Avatar(participant_id), this.member_details_avatar_size);
                }
            },

            updateRightsView: function (ev) {
                !$(ev.target).hasClass('non-active') && this.render(this.participant);
            },

            getParticipantMessages: function (options, callback) {
                this.contact.messages_view = new xabber.ParticipantMessagesView({contact: this.contact, model: this.participant.attributes });
                this.contact.messages_view.messagesRequest(options, function () {
                    this.close();
                    xabber.body.setScreen('all-chats', {right: 'participant_messages', contact: this.contact});
                }.bind(this));
            },

            changeAvatar: function (ev) {
                var field = ev.target;
                if (!field.files.length) {
                    return;
                }
                var file = field.files[0];
                field.value = '';
                if (file.size > constants.MAX_AVATAR_FILE_SIZE) {
                    utils.dialogs.error('File is too large');
                } else if (!file.type.startsWith('image')) {
                    utils.dialogs.error('Wrong image');
                }

                utils.images.getAvatarFromFile(file).done(function (image) {
                    if (image) {
                        file.base64 = image;
                        this.new_avatar = file;
                        this.$('.circle-avatar').addClass('changed').setAvatar(image, this.member_details_avatar_size);
                        this.updateSaveButton();
                    }
                }.bind(this));
            },

            changeTimerValue: function (ev) {
                let $property_item = $(ev.target),
                    $property_value = $property_item.closest('.select-timer').find('.property-value'),
                    $input_item = $property_item.closest('.right-item').find('input');
                if ($property_item.attr('data-value') !== $property_value.attr('data-value')) {
                    $property_item.closest('.right-item').addClass('changed-timer changed');
                    this.updateSaveButton();
                }
                $property_value.text($property_item.text());
                $property_value.attr('data-value', $property_item.attr('data-value'));
                if ($property_item.attr('data-value') === 'never') {
                    $property_value.addClass('default-value').text('set timer');
                } else if ($property_value.hasClass('default-value'))
                    $property_value.removeClass('default-value');
                if (!$input_item.prop('checked')) {
                    $input_item.click();
                }
            },

            updateBadge: function (badge) {
                this.$('.badge').html(badge).switchClass('hidden', !badge);
                this.$('.participant-info').emojify('.badge');
            },

            updateButtons: function (has_changes) {
                this.$('.btn-save-user-rights').switchClass('non-active', !has_changes);
            },

            updateSaveButton: function () {
                let has_changes = this.$('.changed').length;
                this.updateButtons(has_changes);
            },

            updateNickname: function (nickname) {
                let $member_item = this.$('.participant-details-item[data-id="' + this.participant.get('id') + '"]'),
                    $member_item_nickname = $member_item.find('.nickname');
                $member_item_nickname.html(Strophe.xmlescape(nickname));
                $member_item.emojify('.nickname');
                if (nickname !== this.participant.get('nickname'))
                    $member_item_nickname.addClass('changed');
                else
                    $member_item_nickname.removeClass('changed');
                this.updateSaveButton();
            },

            editNickname: function () {
                if (this.contact.get('private_chat') && this.account.get('jid') !== this.participant.get('jid'))
                    return;
                this.$('.participant-info .nickname').hide();
                this.$('.participant-info #edit-nickname').text(this.$('.participant-info .nickname').text()).show().placeCaretAtEnd();
            },

            editBadge: function () {
                this.edit_badge_panel = new xabber.EditBadgeView({model: this});
            },

            checkKeydown: function (ev) {
                if (ev.keyCode === constants.KEY_ENTER) {
                    ev.preventDefault();
                    $(document.activeElement).blur();
                }
            },

            checkKeyup: function (ev) {
                let $richtextarea = $(ev.target),
                    new_value = $richtextarea.getTextFromRichTextarea().trim();
                if (ev.target.id === 'edit-nickname') {
                    let has_changes = (new_value !== this.participant.get('nickname'));
                    this.updateButtons(has_changes);
                }
            },

            retractUserMessages: function () {
                utils.dialogs.ask("User messages retraction", "Do you want to delete all messages of " + (this.participant.get('nickname') || this.participant.get('jid') || this.participant.get('id')) + " in this groupchat?", null, { ok_button_text: 'delete'}).done(function (result) {
                    if (result) {
                        if (this.participant.get('id')) {
                            let group_chat = this.account.chats.getChat(this.model.model);
                            group_chat.retractMessagesByUser(this.participant.get('id'));
                        }
                    }
                }.bind(this));
            },

            blockParticipant: function () {
                utils.dialogs.ask("Block participant", "Do you want to block "+
                    this.participant.get('nickname') + "?", null, { ok_button_text: 'block'}).done(function (result) {
                    if (result) {
                        let contact_id = this.participant.get('id'),
                            jid = this.account.resources.connection.jid,
                            iq = $iq({from: jid, type: 'set', to: this.contact.get('jid')})
                                .c('block', {xmlns: Strophe.NS.GROUP_CHAT + '#block'})
                                .c('id').t(contact_id);
                        this.account.sendIQ(iq, function () {
                                this.close();
                                this.model.$el.find('.members-list-wrap .group-chat-participant[data-id="' + contact_id + '"]').remove();
                                this.model.$el.find('.members-list-wrap').perfectScrollbar('update');
                            }.bind(this),
                            function (error) {
                                if ($(error).find('not-allowed').length)
                                    utils.dialogs.error("You have no permission to block participants");
                            });
                    }
                }.bind(this));
            },

            renderAllRights: function () {
                if (this.contact.all_rights) {
                    this.$('.restrictions-wrap').html("");
                    this.$('.permissions-wrap').html("");
                    this.contact.all_rights.restrictions.each(function (idx, restriction) {
                        var name = $(restriction).attr('name'),
                            pretty_name = $(restriction).attr('translation'),
                            restriction_item = $(templates.group_chats.restriction_item({name: name, pretty_name: pretty_name})),
                            restriction_expire = $(templates.group_chats.right_expire_variants({right_name: name}));
                        restriction_item.append(restriction_expire);
                        this.$('.restrictions-wrap').append(restriction_item);
                        this.$('.right-item #' + name).prop('checked', false);
                    }.bind(this));
                    this.contact.all_rights.permissions.each(function (idx, permission) {
                        var name = $(permission).attr('name'),
                            pretty_name = $(permission).attr('translation'),
                            permission_item = $(templates.group_chats.permission_item({name: name, pretty_name: pretty_name})),
                            permission_expire = $(templates.group_chats.right_expire_variants({right_name: name}));
                        permission_item.append(permission_expire);
                        this.$('.permissions-wrap').append(permission_item);
                        this.$('.right-item #' + name).prop('checked', false);
                    }.bind(this));
                }
            },

            setActualRights: function () {
                var permissions = this.participant.get('permissions'), restrictions = this.participant.get('restrictions');
                permissions.forEach(
                    function(permission) {
                    let permission_name = permission.name,
                        $current_permission = this.$('.right-item.permission-' + permission_name);
                    this.actual_rights.push(permission_name);
                    $current_permission.find('#' + permission_name).prop('checked', true);
                    $current_permission.attr('data-switch', true);
                    let expires_year = parseInt(moment(permission.expires_time).format('YYYY')),
                        issued_at_year = parseInt(moment(permission.issued_time).format('YYYY'));
                    if (!isNaN(expires_year) && !isNaN(issued_at_year))
                        if (expires_year - issued_at_year > 1)
                            return;
                    $current_permission.find('.select-timer .property-value').attr('data-value', permission.expires_time)
                        .removeClass('default-value')
                        .text(moment(permission.expires_time, 'YYYY-MM-DD hh:mm:ss').fromNow());
                }.bind(this));
                restrictions.forEach(function(restriction) {
                    let restriction_name = restriction.name,
                        $current_restriction = this.$('.right-item.restriction-' + restriction_name);
                    this.actual_rights.push(restriction_name);
                    $current_restriction.find('#' + restriction_name).prop('checked', true);
                    $current_restriction.attr('data-switch', true);
                    let expires_year = parseInt(moment(restriction.expires_time).format('YYYY')),
                        issued_at_year = parseInt(moment(restriction.issued_time).format('YYYY'));
                    if (!isNaN(expires_year) && !isNaN(issued_at_year))
                        if (expires_year - issued_at_year > 1)
                            return;
                    $current_restriction.find('.select-timer .property-value').attr('data-value', restriction.expires_time)
                        .removeClass('default-value')
                        .text(moment(restriction.expires_time, 'YYYY-MM-DD hh:mm:ss').fromNow());
                }.bind(this));
            },

            getPrivateChat: function (ev) {
                if ($(ev.target).closest('.button-wrap').hasClass('non-active'))
                    return;
                let participant_jid = this.participant.get('jid'),
                    participant_in_roster = this.account.contacts.get(participant_jid);
                if (!participant_jid) {
                    let iq = $iq({from: this.account.get('jid'), to: this.account.domain/*Strophe.getDomainFromJid(this.contact.get('jid'))*/, type: 'set'})
                        .c('create', { xmlns: Strophe.NS.GROUP_CHAT})
                        .c('peer-to-peer', { jid: this.contact.get('jid'),  id: this.participant.get('id')});
                    this.account.sendIQ(iq, function (iq_response) {
                        let group_jid = $(iq_response).find('created jid').text(),
                            contact = this.account.contacts.mergeContact(group_jid);
                        contact.set('group_chat', true);
                        contact.pres('subscribed');
                        contact.pushInRoster(null, function () {
                            contact.pres('subscribe');
                            contact.getMyInfo();
                            this.close();
                            contact.subGroupPres();
                            this.account.chats.openChat(contact);
                            let chat = this.account.chats.getChat(contact);
                            chat.messages.createSystemMessage({
                                from_jid: group_jid,
                                message: 'Initiating private chat with ' + this.participant.get('nickname') + ' from ' + this.contact.get('jid') + '. If your invitation is accepted, you won\'t see each other\'s real XMPP IDs.'
                            });
                        }.bind(this));
                    }.bind(this), function (error) {
                        let $error = $(error),
                            private_chat_jid = $error.find('x[xmlns="' + Strophe.NS.GROUP_CHAT + '"] jid').text();
                        if (private_chat_jid) {
                            let contact = this.account.contacts.mergeContact(private_chat_jid),
                                chat = this.account.chats.getChat(contact);
                            this.close();
                            chat && chat.trigger('open');
                            return;
                        }
                        let err_text = $(error).find('text[lang="en"]').text() || $(error).find('text').first().text() || 'You have already sent an invitation to peer-to-peer chat';
                        this.close();
                        utils.dialogs.error(err_text);
                    }.bind(this));
                }
                else {
                    if (participant_in_roster)
                        if (participant_in_roster.get('in_roster')) {
                            this.close();
                            participant_in_roster.trigger('open_chat', participant_in_roster);
                            return;
                        }
                    this.close();
                    xabber.add_contact_view.show({
                        account: this.account,
                        jid: participant_jid
                    });
                }
            },

            changeRights: function (ev) {
                let $target = $(ev.target),
                    $right_item = $target.closest('.right-item'),
                    right_name = $target.prop('id');
                if ($target.prop('checked')) {
                    if (!this.actual_rights.find(right => right === right_name))
                        $right_item.addClass('changed');
                    else
                        if ($right_item.hasClass('changed-timer'))
                            $right_item.addClass('changed');
                        else
                            $right_item.removeClass('changed');
                }
                else {
                    if (this.actual_rights.find(right => right === right_name))
                        $right_item.addClass('changed');
                    else {
                        $right_item.removeClass('changed');
                        if ($right_item.hasClass('changed-timer'))
                            $right_item.find('.timer-item-wrap .property-value').addClass('default-value').text('set timer').attr('data-value', 'never');
                    }
                }
                this.updateSaveButton();
            },

            saveRights: function (ev) {
                if ($(ev.target).hasClass('non-active'))
                    return;
                let $btn = $(ev.target),
                    jid = this.account.get('jid'),
                    member_id = this.participant.get('id'),
                    $participant_avatar = this.$('.participant-details-item .circle-avatar'),
                    nickname_value = this.$('.participant-info .nickname').text(),
                    changed_avatar = this.new_avatar,
                    has_changes = false,
                    iq_changes = $iq({from: jid, type: 'set', to: this.contact.get('jid')})
                        .c('query', {xmlns: Strophe.NS.GROUP_CHAT + "#members"})
                        .c('item', {id: member_id});
                this.$('.buttons-wrap button').addClass('non-active');
                changed_avatar && $participant_avatar.find('.preloader-wrap').addClass('visible').find('.preloader-wrapper').addClass('active');
                if (nickname_value != this.participant.get('nickname')) {
                    has_changes = true;
                    iq_changes.c('nickname').t(nickname_value).up();
                }
                this.$('.right-item').each(function(idx, right_item) {
                    if ($(right_item).hasClass('changed')) {
                        var $right_item = $(right_item),
                            right_type = $right_item.hasClass('restriction') ? 'restriction' : 'permission',
                            right_name = $right_item.find('.field input')[0].id;
                        if ($right_item.find('.field input:checked').val()) {
                            let right_expire = $right_item.find('.select-timer .timer-item-wrap .property-value').attr('data-value');
                            iq_changes.c(right_type, {name: right_name, expires: right_expire}).up();
                            has_changes = true;
                        }
                        else
                            if ($right_item.attr('data-switch')) {
                                iq_changes.c(right_type, {name: right_name, expires: 'now'}).up();
                                has_changes = true;
                            }
                    }
                }.bind(this));
                if (changed_avatar)
                    this.contact.pubAvatar(changed_avatar, ('#' + member_id), function () {
                        this.$('.buttons-wrap button').removeClass('non-active');
                        $participant_avatar.find('.preloader-wrap').removeClass('visible').find('.preloader-wrapper').removeClass('active');
                        this.model.$('.members-list-wrap .list-item[data-id="'+ member_id +'"] .circle-avatar').setAvatar(changed_avatar.base64, this.member_avatar_size);
                        this.$('.participant-details-item[data-id="'+ member_id +'"] .circle-avatar').setAvatar(changed_avatar.base64, this.member_details_avatar_size);
                        this.close();
                    }.bind(this), function (error) {
                        this.$('.buttons-wrap button').removeClass('non-active');
                        $participant_avatar.find('.preloader-wrap').removeClass('visible').find('.preloader-wrapper').removeClass('active');
                        let error_text = $(error).find('text').text() || 'You have no permissions to change avatar';
                        !has_changes && utils.dialogs.error(error_text);
                    });
                if (has_changes)
                    this.account.sendIQ(iq_changes,
                        function () {
                            this.$('.buttons-wrap button').removeClass('non-active');
                            this.participant.set('nickname', nickname_value);
                            this.close();
                        }.bind(this),
                        function (error) {
                            this.$('.buttons-wrap button').removeClass('non-active');
                            this.close();
                            if ($(error).find('not-allowed').length) {
                                utils.dialogs.error("You have no permission to change participant's info");
                            }
                        }.bind(this));
                $btn.blur();
            }
        });

        xabber.EditBadgeView = xabber.BasicView.extend({
            className: 'modal edit-badge',
            template: templates.group_chats.badge_edit_view,

            events: {
                "click .btn-cancel": "close",
                "click .btn-save": "saveNewBadge",
                "keydown .badge-text": "checkKey"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.contact = this.model.contact;
                this.participant = this.model.participant;
                this.$el.openModal({
                    ready: function () {
                        if (this.participant.get('badge'))
                            this.typeEmoticon(this.participant.get('badge'));
                        else
                            this.$('.badge-text').focus();
                    }.bind(this),
                    complete: function () {
                        this.$el.detach();
                        this.data.set('visible', false);
                    }.bind(this)
                });
                var $insert_emoticon = this.$('.insert-emoticon'),
                    $emoji_panel_wrap = this.$('.emoticons-panel-wrap'),
                    $emoji_panel = this.$('.emoticons-panel'),
                    _timeout;

                _.each(Emoji.all, function (emoji) {
                    $('<div class="emoji-wrap"/>').html(
                        emoji.emojify({tag_name: 'div', emoji_size: 25})
                    ).appendTo($emoji_panel);
                });
                $emoji_panel.perfectScrollbar(
                    _.extend({theme: 'item-list'}, xabber.ps_settings));
                $insert_emoticon.hover(function (ev) {
                    if (ev && ev.preventDefault) { ev.preventDefault(); }
                    $emoji_panel_wrap.addClass('opened');
                    if (_timeout) {
                        clearTimeout(_timeout);
                    }
                    $emoji_panel.perfectScrollbar('update');
                }.bind(this), function (ev) {
                    if (ev && ev.preventDefault) { ev.preventDefault(); }
                    if (_timeout) {
                        clearTimeout(_timeout);
                    }
                    _timeout = setTimeout(function () {
                        if (!$emoji_panel_wrap.is(':hover')) {
                            $emoji_panel_wrap.removeClass('opened');
                        }
                    }, 800);
                }.bind(this));
                $emoji_panel_wrap.hover(null, function (ev) {
                    if (ev && ev.preventDefault) { ev.preventDefault(); }
                    if (_timeout) {
                        clearTimeout(_timeout);
                    }
                    _timeout = setTimeout(function () {
                        $emoji_panel_wrap.removeClass('opened');
                    }, 200);
                }.bind(this));
                $emoji_panel_wrap.mousedown(function (ev) {
                    if (ev && ev.preventDefault) { ev.preventDefault(); }
                    if (ev.button) {
                        return;
                    }
                    var $target = $(ev.target).closest('.emoji-wrap').find('.emoji');
                    $target.length && this.typeEmoticon($target.data('emoji'));
                }.bind(this));
            },

            close: function () {
                this.$el.closeModal({ complete: this.hide.bind(this) });
            },

            saveNewBadge: function () {
                let new_badge = this.$('.badge-text').getTextFromRichTextarea().trim();
                if (new_badge.length > 32) {
                    this.$('.modal-content .error').text("Badge can't be longer than 32 symbols");
                }
                else {
                    if (new_badge != this.participant.get('badge')) {
                        let iq_changes = $iq({from: this.account.get('jid'), type: 'set', to: this.contact.get('jid')})
                            .c('query', {xmlns: Strophe.NS.GROUP_CHAT + "#members"})
                            .c('item', {id: this.participant.get('id')})
                            .c('badge').t(new_badge);
                        this.account.sendIQ(iq_changes, function () {
                                this.model.updateBadge(new_badge);
                                this.close();
                            }.bind(this),
                            function () {
                                this.$('.modal-content .error').text("You have no permission");
                            }.bind(this))
                    }
                }
            },

            typeEmoticon: function (emoji) {
                var emoji_node = emoji.emojify({tag_name: 'img'}),
                    $textarea = this.$('.badge-text');
                $textarea.focus();
                window.document.execCommand('insertHTML', false, emoji_node);
            },

            checkKey: function (ev) {
                if (ev.keyCode === constants.KEY_ENTER) {
                    ev.preventDefault();
                    this.saveNewBadge();
                }
            }

        });


        xabber.DefaultRestrictionsView = xabber.BasicView.extend({
            className: 'modal dialog-modal edit-default-restrictions',
            template: templates.group_chats.default_restrictions,
            events: {
                "click .btn-default-restrictions-save": "saveChanges",
                "click .btn-default-restrictions-cancel": "close",
                "change #default_restriction_expires": "changeExpiresTime",
                "click .group-info-editor .property-variant": "changePropertyValue",
                "click .select-timer .property-variant": "changeTimerValue",
                "click .clickable-field input": "changeRestriction",
                "keyup .clickable-field input": "keyUpInput",
                "change .clickable-field input": "updateSaveButton"
            },

            _initialize: function () {
                this.contact = this.model;
                this.account = this.contact.account;
                this.model.on("change: name", this.updateName, this);
                this.model.on("change: group_info", this.update, this);
            },

            open: function () {
                this.$el.openModal({
                    ready: function () {
                        this.update();
                        this.updateScrollBar();
                    }.bind(this),
                    complete: function () {
                        this.showDefaultRestrictions();
                        this.$el.detach();
                        this.data.set('visible', false);
                    }.bind(this)
                });
            },

            close: function () {
                this.$el.closeModal({
                    complete: function () {
                        this.showDefaultRestrictions();
                        this.hide.bind(this);
                    }.bind(this)
                });
            },

            update: function () {
                this.$('.btn-default-restrictions-save').addClass('non-active');
                this.actual_default_restrictions = [];
                this.showDefaultRestrictions();
                let dropdown_settings = {
                    inDuration: 100,
                    outDuration: 100,
                    constrainWidth: false,
                    hover: false,
                    alignment: 'left'
                };
                this.$('.property-field .dropdown-button').dropdown(dropdown_settings);
            },

            updateSaveButton: function () {
                let has_changes = false;
                this.$('.default-restrictions-list-wrap .right-item').each(function (idx, item) {
                    let $item = $(item),
                        restriction_name = $item.find('input').attr('id'),
                        restriction_expires = $item.find('.select-timer .property-value').attr('data-value');
                    restriction_name = restriction_name.slice(8, restriction_name.length);
                    if (!this.actual_default_restrictions.find(restriction => ((restriction.name == restriction_name) && (restriction.expires == restriction_expires)))) {
                        if ($item.find('input').prop('checked'))
                            has_changes = true;
                        else if (this.actual_default_restrictions.find(restriction => restriction.name == restriction_name))
                            has_changes = true;
                    }
                }.bind(this));
                this.$('.btn-default-restrictions-save').switchClass('non-active', !has_changes);
            },

            changeRestriction: function (ev) {
                let $target = $(ev.target);
                if (!$target.prop('checked')) {
                    $target.closest('.right-item').find('.select-timer .property-value').attr('data-value', 'never').addClass('default-value')
                        .text('set timer');
                }
            },

            keyUpInput: function (ev) {
                if (ev.keyCode === constants.KEY_ENTER)
                    $(ev.target).click();
            },

            changePropertyValue: function (ev) {
                let $property_item = $(ev.target),
                    $property_value = $property_item.closest('.property-field').find('.property-value');
                $property_value.text($property_item.text());
                $property_value.attr('data-value', $property_item.attr('data-value'));
            },

            changeTimerValue: function (ev) {
                let $property_item = $(ev.target),
                    $property_value = $property_item.closest('.select-timer').find('.property-value'),
                    $input_item = $property_item.closest('.right-item').find('input');
                $property_value.text($property_item.text());
                $property_value.attr('data-value', $property_item.attr('data-value'));
                if ($property_item.attr('data-value') === 'never') {
                    $property_value.addClass('default-value');
                    $property_value.text('set timer');
                } else if ($property_value.hasClass('default-value'))
                    $property_value.removeClass('default-value');
                if (!$input_item.prop('checked'))
                    $input_item.prop('checked', true);
                this.updateSaveButton();
            },

            showDefaultRestrictions: function () {
                this.$('button').blur();
                let iq_get_rights = $iq({from: this.account.get('jid'), type: 'get', to: this.contact.get('jid') })
                    .c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#rights' });
                this.account.sendIQ(iq_get_rights, function(iq_all_rights) {
                    var all_permissions = $(iq_all_rights).find('permission'),
                        all_restrictions = $(iq_all_rights).find('restriction');
                    this.contact.all_rights = {permissions: all_permissions, restrictions: all_restrictions};
                    this.contact.all_rights.restrictions.each(function (idx, restriction) {
                        let name = $(restriction).attr('name'),
                            expires_restriction = $(restriction).attr('expires'),
                            view = this.$('.default-restrictions-list-wrap .right-item.restriction-default-' + name),
                            pretty_name = $(restriction).attr('translation'),
                            restriction_item = $(templates.group_chats.restriction_item({name: ('default-' + name), pretty_name: pretty_name})),
                            restriction_expire = $(templates.group_chats.right_expire_variants({right_name: ('default-' + name)}));
                        if (expires_restriction)
                            this.actual_default_restrictions.push({ name: name, expires: expires_restriction});
                        if (view.length)
                            view.detach();
                        restriction_item.append(restriction_expire);
                        this.$('.default-restrictions-list-wrap').append(restriction_item);
                        if (expires_restriction) {
                            this.$('.right-item #default-' + name).prop('checked', true).addClass(expires_restriction);
                            if (expires_restriction !== 'never') {
                                let $current_restriction = this.$('.right-item.restriction-default-' + name);
                                $current_restriction.find('.select-timer .property-value').attr('data-value', expires_restriction)
                                    .removeClass('default-value')
                                    .text(expires_restriction);
                            }
                        }
                        else
                            this.$('.right-item #' + name).prop('checked', false);
                    }.bind(this));
                    this.$el.removeClass('request-waiting');
                    this.$('.select-timer .dropdown-button').dropdown({
                        inDuration: 100,
                        outDuration: 100,
                        constrainWidth: false,
                        hover: false,
                        alignment: 'left'
                    });
                }.bind(this));
            },

            saveChanges: function () {
                if (this.$('.btn-default-restrictions-save').hasClass('non-active'))
                    return;
                this.$('button').blur();
                let iq_change_default_rights = $iq({from: this.account.get('jid'), to: this.contact.get('jid'), type: 'set'})
                        .c('query', {xmlns: Strophe.NS.GROUP_CHAT + '#rights'}),
                    has_new_default_restrictions = false;
                this.$('.default-restrictions-list-wrap .right-item').each(function (idx, item) {
                    let $item = $(item),
                        restriction_name = $item.find('input').attr('id'),
                        restriction_expires = $item.find('.select-timer .property-value').attr('data-value');
                    restriction_name = restriction_name.slice(8, restriction_name.length);
                    if (!this.actual_default_restrictions.find(restriction => ((restriction.name == restriction_name) && (restriction.expires == restriction_expires)))) {
                        if ($item.find('input').prop('checked')) {
                            iq_change_default_rights.c('restriction', {
                                name: restriction_name,
                                expires: restriction_expires
                            }).up();
                            has_new_default_restrictions = true;
                        }
                        else if (this.actual_default_restrictions.find(restriction => restriction.name == restriction_name)) {
                            iq_change_default_rights.c('restriction', {name: restriction_name, expires: 'now'}).up();
                            has_new_default_restrictions = true;
                        }
                    }
                }.bind(this));

                if (has_new_default_restrictions)
                    this.account.sendIQ(iq_change_default_rights, function () {
                        this.close();
                    }.bind(this), function () {
                        let err_text = $(error).find('error text').text() || 'You have no permission to change default restrictions';
                        utils.dialogs.error(err_text);
                        this.close();
                    }.bind(this));
            },

            changeExpiresTime: function (ev) {
                var expire_time_item = $(ev.target),
                    new_expire_time = expire_time_item.val(),
                    $restriction_item = expire_time_item.prev();
                if (expire_time_item.val() == 'never')
                    $restriction_item .find('.restriction-description').text('Indefinitely');
                else
                    $restriction_item .find('.restriction-description').text('For ' + new_expire_time);
                $restriction_item .find('input').removeClass().addClass(new_expire_time);
                expire_time_item.remove();
            }
        });

        xabber.Participant = Backbone.Model.extend({
            idAttribute: 'id',

            initialize: function (_attrs, options) {
                let attrs = _.clone(_attrs);
                this.contact = options.contact;
                this.account = this.contact.account;
                this.on("change:avatar", this.getBase64Avatar, this);
                this.set(attrs);
                this.getBase64Avatar();
            },

            getBase64Avatar: function () {
                if (this.get('avatar')) {
                    let cached_info = this.account.chat_settings.getAvatarInfoById(this.get('id'));
                    if (cached_info) {
                        if (cached_info.avatar_hash == this.get('avatar')) {
                            this.set('b64_avatar', cached_info.avatar_b64);
                            (this.get('jid') === this.account.get('jid')) && this.contact.trigger('update_my_info');
                            return;
                        }
                    }
                    let node = Strophe.NS.PUBSUB_AVATAR_DATA + '#' + this.get('id');
                    this.contact.getAvatar(this.get('avatar'), node, function (avatar) {
                        this.account.chat_settings.updateCachedAvatars(this.get('id'), this.get('avatar'), avatar);
                        this.set('b64_avatar', avatar);
                        (this.get('jid') === this.account.get('jid')) && this.contact.trigger('update_my_info');
                    }.bind(this));
                }
            }
        });

        xabber.Participants = Backbone.Collection.extend({
            model: xabber.Participant,
            comparator: 'nickname',

            initialize: function (models, options) {
                this.contact = options.contact;
                this.account = this.contact.account;
                this.version = this.account.groupchat_settings.getParticipantsListVersion(this.contact.get('jid'));
                this.getCachedParticipants();
                this.on("change:nickname", this.sort, this);
            },

            updateVersion: function () {
                this.version = this.account.groupchat_settings.getParticipantsListVersion(this.contact.get('jid')) || this.version;
            },

            getCachedParticipants: function () {
                this.account.groupchat_settings.getParticipantsList(this.contact.get('jid')).forEach(function (participant) {
                    this.mergeParticipant(participant);
                }.bind(this));
            },

            mergeParticipant: function (attrs) {
                if (typeof attrs !== "object")
                    attrs = {id: attrs};
                let participant = this.get(attrs.id);
                if (participant)
                    participant.set(attrs);
                else {
                    participant = this.create(attrs, {contact: this.contact});
                }
                return participant;
            },

            resetParticipants: function () {
                this.version = 0;
                _.each(_.clone(this.models), function (participant) {
                    participant.destroy();
                });
            },

            getRole: function (permissions) {
                let role = 1;
                if (!permissions.length)
                    role = 0;
                else
                    permissions.find(permission => permission.name === 'owner') && (role = 2);
                return constants.PARTICIPANT_ROLES[role];
            },

            getRights: function (rights) {
                let pretty_rights = [];
                $(rights).each(function(idx, permission) {
                    let name = $(permission).attr('name'),
                        pretty_name = $(permission).attr('translation'),
                        issued_time = $(permission).attr('issued-at'),
                        expires_time = $(permission).attr('expires');
                    pretty_rights.push({
                        name: name,
                        pretty_name: pretty_name,
                        issued_time: issued_time,
                        expires_time: expires_time
                    });
                }.bind(this));
                return pretty_rights;
            },

            createFromStanza: function ($item) {
                let jid = $item.find('jid').text(),
                    nickname = $item.find('nickname').text(),
                    id = $item.find('id').text(),
                    badge = $item.find('badge').text(),
                    present = $item.find('present').text(),
                    photo = $item.find('metadata[xmlns="' + Strophe.NS.PUBSUB_AVATAR_METADATA + '"]').find('info').attr('id'),
                    permissions = this.getRights($item.find('permission')),
                    restrictions = this.getRights($item.find('restriction')),
                    role = this.getRole(permissions);
                !nickname.trim().length && (nickname = jid || id);

                let attrs = {
                    jid: jid,
                    id: id,
                    avatar: photo,
                    nickname: nickname,
                    badge: badge,
                    present: present,
                    role: role,
                    permissions: permissions,
                    restrictions: restrictions
                };

                let participant = this.mergeParticipant(attrs);
                (this.account.get('jid') === participant.get('jid')) && (this.contact.my_info = participant) && this.contact.trigger('permissions_changed') && this.contact.trigger('update_my_info');
                this.account.groupchat_settings.updateParticipant(this.contact.get('jid'), attrs);
                return participant;
            }
        });

        xabber.GroupChatSettings = Backbone.ModelWithStorage.extend({
            defaults: {
                participants_lists: []
            },

            getParticipantsListVersion: function (jid) {
                let all_participants_lists = _.clone(this.get('participants_lists')),
                    result = all_participants_lists.find(list => list.jid === jid);
                if (result)
                    return result.version;
                else
                    return 0;
            },

            setParticipantsListVersion: function (jid, version) {
                let all_participants_lists = _.clone(this.get('participants_lists')),
                    participants_list = all_participants_lists.find(list => list.jid === jid),
                    participants_list_idx = all_participants_lists.indexOf(participants_list);
                if (participants_list_idx != -1) {
                    all_participants_lists.splice(participants_list_idx, 1);
                }
                if (!participants_list) {
                    participants_list = {jid: jid, participants_list: [], version: 0};
                }
                else
                    participants_list.version = version;
                all_participants_lists.push(participants_list);
                this.save('participants_lists', all_participants_lists);
            },

            getParticipantsList: function (jid) {
                let all_participants_lists = _.clone(this.get('participants_lists')),
                    result = all_participants_lists.find(list => list.jid === jid);
                if (result && result.participants_list)
                    return result.participants_list;
                else
                    return [];
            },

            updateParticipant: function (jid, participant_info) {
                let all_participants_lists = _.clone(this.get('participants_lists')),
                    chat_participants = all_participants_lists.find(list => list.jid === jid),
                    version = chat_participants && chat_participants.version || 0,
                    participants_list = chat_participants && chat_participants.participants_list || [],
                    participants_list_idx = all_participants_lists.indexOf(chat_participants);
                if (participants_list.length) {
                    let participant = participants_list.find(participant_item => participant_item.id === participant_info.id),
                        participant_idx = participants_list.indexOf(participant);
                    if (participant_idx != -1)
                        participants_list[participant_idx] = participant_info;
                    else
                        participants_list.push(participant_info);
                }
                else
                    participants_list.push(participant_info);
                if (participants_list_idx != -1) {
                    all_participants_lists.splice(participants_list_idx, 1);
                }
                all_participants_lists.push({jid: jid, participants_list: participants_list, version: version});
                this.save('participants_lists', all_participants_lists);
            },

            setParticipantsList: function (jid, updated_participants_list) {
                let all_participants_lists = _.clone(this.get('participants_lists')),
                    participants_list = all_participants_lists.find(list => list.jid === jid) || [],
                    participants_list_idx = all_participants_lists.indexOf(participants_list);
                if (participants_list_idx != -1) {
                    all_participants_lists.splice(participants_list_idx, 1);
                }
                all_participants_lists.push({jid: jid, participants_list: updated_participants_list, version: participants_list.version});
                this.save('participants_lists', all_participants_lists);
            },

            removeParticipantFromList: function (jid, participant_id) {
                let participants_list = this.getParticipantsList(jid);
                if (participants_list.length) {
                    var participant_idx = participants_list.indexOf(participants_list.find(participant => participant.id === participant_id));
                    if (participant_idx != -1)
                        participants_list.splice(participant_idx, 1);
                    this.setParticipantsList(jid, participants_list);
                }
            },

            resetParticipantsList: function (jid) {
                let all_participants_lists = _.clone(this.get('participants_lists')),
                    participants_list_idx = all_participants_lists.indexOf(all_participants_lists.find(list => list.jid === jid));
                if (participants_list_idx != -1) {
                    all_participants_lists.splice(participants_list_idx, 1);
                }
                all_participants_lists.push({jid: jid, participants_list: [], version: 0});
                this.save('participants_lists', all_participants_lists);
            }
        });

        xabber.ContactInvitationView = xabber.BasicView.extend({
            className: 'details-panel invitation-view',
            template: templates.group_chats.invitation,
            ps_selector: '.panel-content',
            avatar_size: constants.AVATAR_SIZES.CONTACT_DETAILS,

            events: {
                "click .btn-chat": "openChat",
                "click .btn-accept": "addContact",
                "click .btn-join": "joinGroupChat",
                "click .btn-decline": "declineContact",
                "click .btn-decline-all": "declineAll",
                "click .btn-block": "blockContact",
                "click .btn-escape": "closeInvitationView"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.name_field = this.model.get('name');
                this.updateName();
                this.updateStatus();
                this.updateAvatar();
                this.$('.invite-msg .invite-msg-text')
                    .text('User requests permission to add you to his contact list. If you accept, '+ this.model.get('jid') + ' will also be added to ' +  this.account.get('jid') + ' contacts');
                this.model.on("change", this.update, this);
            },

            render: function (options) {
                this.$('.btn-escape').showIf(!this.model.get('group_chat'));
                this.renderButtons();
            },

            onChangedVisibility: function () {
                if (this.isVisible()) {
                    this.model.set({display: true, active: true});
                } else {
                    this.model.set({display: false});
                }
            },

            update: function () {
                var changed = this.model.changed;
                if (_.has(changed, 'name')) this.updateName();
                if (_.has(changed, 'image')) this.updateAvatar();
                if (_.has(changed, 'status_updated')) this.updateStatus();
                if (_.has(changed, 'group_chat')) this.updateGroupChat();
            },

            updateName: function () {
                this.$('.main-info  .name-wrap').text(this.model.get('name'));
                if (this.model.get('name-wrap') == this.model.get('jid')) {
                    this.$('.main-info .name-wrap').addClass('name-is-jid');
                    this.$('.main-info  .jid').text('');
                }
                else {
                    this.$('.main-info .name-wrap').removeClass('name-is-jid');
                    this.$('.main-info  .jid').text(this.model.get('jid'));
                }
            },

            updateStatus: function () {
                this.$('.status').attr('data-status', this.model.get('status'));
                this.$('.status-message').text(this.model.getStatusMessage());
            },

            updateAvatar: function () {
                var image = this.model.cached_image;
                this.$('.circle-avatar').setAvatar(image, this.avatar_size);
            },

            renderButtons: function () {
                this.$('.buttons-wrap .btn-accept').hideIf(this.model.get('group_chat') && !this.private_invite);
                this.$('.buttons-wrap .btn-block').hideIf(this.model.get('group_chat') && this.private_invite);
                this.$('.buttons-wrap .btn-join').showIf(this.model.get('group_chat') && !this.private_invite);
                this.$('.buttons-wrap .btn-decline-all').showIf(this.model.get('group_chat') && this.private_invite);
            },

            updateGroupChat: function () {
                this.renderButtons();
                if (this.model.get('group_chat') && !this.private_invite) {
                    this.updateInviteMsg('You are invited to group chat. If you accept, ' + this.account.get('jid') + ' username shall be visible to group chat participants');
                }
            },

            updateInviteMsg: function (msg) {
                this.$('.invite-msg .invite-msg-text').text(msg);
            },

            openChat: function () {
                this.model.set('in_roster', true);
                this.model.trigger("open_chat", this.model);
            },

            addContact: function () {
                if (this.private_invite) {
                    this.joinGroupChat();
                    return;
                }
                var contact = this.model;
                contact.acceptRequest();
                this.changeInviteStatus();
                contact.trigger('remove_invite', contact);
                contact.showDetails('all-chats');
            },

            blockInvitation: function () {
                let contact_jid = this.model.get('jid'),
                    iq_get_blocking = $iq({type: 'get'}).c('blocklist', {xmlns: Strophe.NS.BLOCKING}),
                    iq_unblocking = $iq({type: 'set'}).c('unblock', {xmlns: Strophe.NS.BLOCKING}),
                    iq_set_blocking = $iq({type: 'set'}).c('block', {xmlns: Strophe.NS.BLOCKING})
                    .c('item', {jid: this.model.get('jid') + '/' + moment.now()});
                this.account.sendIQ(iq_get_blocking, function (iq_blocking_items) {
                    let items = $(iq_blocking_items).find('item');
                    if (items.length > 0) {
                        items.each(function (idx, item) {
                            let item_jid = $(item).attr('jid');
                            if (item_jid.indexOf(contact_jid) > -1)
                                iq_unblocking.c('item', {jid: item_jid}).up();
                        });
                    }
                    if ($(iq_unblocking.nodeTree).find('item').length)
                        this.account.sendIQ(iq_unblocking, function () {
                            this.account.sendIQ(iq_set_blocking);
                        }.bind(this));
                    else
                        this.account.sendIQ(iq_set_blocking);
                }.bind(this));
            },

            changeInviteStatus: function() {
                let contact = this.model,
                    chat = this.account.chats.getChat(contact);
                chat.set('is_accepted', true);
                this.message && chat.sendMarker(this.message.get('msgid'), 'displayed', this.message.get('archive_id'), this.message.get('contact_archive_id'));
                chat.item_view.content.readMessages();
                var invites = chat.item_view.content.$('.auth-request');
                if (invites.length > 0) {
                    invites.each(function (idx, item) {
                        var msg = chat.messages.get(item.dataset.msgid);
                        msg.set('is_accepted', true);
                    }.bind(this));
                }
            },

            joinGroupChat: function () {
                var contact = this.model;
                this.changeInviteStatus();
                contact.acceptRequest();
                contact.askRequest();
                contact.pushInRoster();
                this.blockInvitation();
                contact.trigger('remove_invite', contact);
                contact.subGroupPres();
                contact.getMyInfo();
                this.openChat();
            },

            declineContact: function () {
                var contact = this.model;
                this.changeInviteStatus();
                contact.declineRequest();
                this.blockInvitation();
                contact.trigger('remove_invite', contact);
                var declined_chat =  xabber.chats_view.active_chat;
                declined_chat.model.set('active', false);
                declined_chat.content.head.closeChat();
                xabber.body.setScreen('all-chats', {right: null});
            },

            declineAll: function () {
                if (this.model.get('private_chat') && this.model.get('private_chat') !== true) {
                    let pres = $pres({from: this.account.connection.jid, to: this.model.get('private_chat')})
                        .c('peer-to-peer').t(false);
                    this.account.sendPres(pres);
                }
                this.model.trigger('remove_invite', this.model);
                var declined_chat =  xabber.chats_view.active_chat;
                declined_chat.model.set('active', false);
                declined_chat.content.head.closeChat();
                xabber.body.setScreen('all-chats', {right: null});
            },

            closeInvitationView: function () {
                this.changeInviteStatus();
                this.openChat();
            },

            blockContact: function (ev) {
                var contact = this.model;
                this.changeInviteStatus();
                utils.dialogs.ask("Block contact", "Do you want to block "+
                    contact.get('name')+"?", null, { ok_button_text: 'block'}).done(function (result) {
                    if (result) {
                        contact.trigger('remove_invite', contact);
                        contact.block();
                        xabber.trigger("clear_search");
                    }
                });
                if (contact.get('group_chat'))
                    this.blockInvitation();
                this.openChat();
            }
        });

        xabber.ContactNameWidget = xabber.InputWidget.extend({
            field_name: 'contact-name',
            placeholder: "",
            model_field: 'name',

            setValue: function (value) {
                if (name === "") {
                    this.model.set('roster_name', null);
                    let name = this.getDefaultName();
                    this.model.set('name', name);
                }
                this.model.pushInRoster({name: value});
            },

            getDefaultName: function () {
                let name = null;
                if (this.model.get('group_chat')) {
                    if (this.model.get('group_info'))
                        name = this.model.get('group_info').name;
                    else
                        name = this.model.get('jid');
                }
                else {
                    let vcard = this.model.get('vcard');
                    name = vcard.nickname || vcard.fullname || (vcard.first_name + ' ' + vcard.last_name).trim() || this.model.get('jid');
                }
                return name;
            },

            keyUp: function (ev) {
                var value = this.getValue();
                this.$input.switchClass('changed', this.$input.val() !== value);
                if (!this.$input.val())
                    this.$input.prop('placeholder', this.getDefaultName() || 'Set contact name');
            }
        });

        xabber.ContactEditGroupsView = xabber.BasicView.extend({
            template: templates.groups,
            events: {
                'click .existing-group-field label': 'editGroup',
                'change .new-group-name input': 'checkNewGroup',
                'keyup .new-group-name input': 'checkNewGroup',
                'click .new-group-checkbox': 'addNewGroup'
            },

            _initialize: function (options) {
                this.account = this.parent.account;
                this.model = this.parent.model;
                this.model.on("change:in_roster update_groups", this.render, this);
            },

            render: function () {
                this.$el.html(this.template());
                if (this.model.get('in_roster')) {
                    var groups = _.clone(this.model.get('groups')),
                        all_groups = _.map(this.account.groups.notSpecial(), function (group) {
                            var name = group.get('name');
                            return {name: name, checked: _.contains(groups, name), id: uuid()};
                        });
                    this.$('.groups').html(templates.groups_checkbox_list({
                        groups: all_groups
                    })).appendTo(this.$('.groups-wrap'));
                }
                this.$el.showIf(this.model.get('in_roster'));
                this.parent.updateScrollBar();
            },

            editGroup: function (ev) {
                var $target = $(ev.target),
                    $input = $target.siblings('input'),
                    checked = !$input.prop('checked'),
                    group_name = $input.attr('data-groupname'),
                    groups = _.clone(this.model.get('groups')),
                    idx = groups.indexOf(group_name);
                $input.prop('checked', checked);
                if (checked) {
                    groups.push(group_name);
                } else if (idx >= 0) {
                    groups.splice(idx, 1);
                }
                this.model.pushInRoster({groups: groups});
            },

            checkNewGroup: function (ev) {
                var name = $(ev.target).val(),
                    $checkbox = this.$('.new-group-checkbox');
                $checkbox.showIf(name && !this.account.groups.get(name));
            },

            addNewGroup: function (ev) {
                var $input = this.$('.new-group-name input'),
                    name = $input.val(),
                    groups = _.clone(this.model.get('groups')),
                    idx = groups.indexOf(name);
                if (idx < 0) {
                    groups.push(name);
                }
                this.model.pushInRoster({groups: groups});
            }
        });

        xabber.ContactsBase = Backbone.Collection.extend({
            model: xabber.Contact
        });

        xabber.GroupContacts = xabber.ContactsBase.extend({
            initialize: function (models, options) {
                this.group = options.group;
                this.on("change", this.onContactChanged, this);
            },

            comparator: function (contact1, contact2) {
                if (xabber.settings.roster.sorting === 'online-first') {
                    var s1 = contact1.get('status'),
                        s2 = contact2.get('status'),
                        sw1 = constants.STATUS_WEIGHTS[s1],
                        sw2 = constants.STATUS_WEIGHTS[s2],
                        sw1_offline = sw1 >= constants.STATUS_WEIGHTS.offline,
                        sw2_offline = sw2 >= constants.STATUS_WEIGHTS.offline;
                    if (sw1_offline ^ sw2_offline) {
                        return sw1_offline ? 1 : -1;
                    }
                }
                var name1, name2;
                name1 = contact1.get('name').toLowerCase();
                name2 = contact2.get('name').toLowerCase();
                return name1 < name2 ? -1 : (name1 > name2 ? 1 : 0);
            },

            onContactChanged: function (contact) {
                var changed = contact.changed;
                if (_.has(changed, 'name') || _.has(changed, 'status_updated')) {
                    this.sort();
                    this.trigger('update_contact_item', contact);
                }
            }
        });

        xabber.Group = Backbone.Model.extend({
            defaults: {
                counter: {all: 0, online: 0}
            },

            initialize: function (attrs, options) {
                this.account = options.account;
                attrs.name || (attrs.name = attrs.id);
                this.set(attrs);
                this._settings = this.account.groups_settings.get(attrs.name);
                if (!this._settings) {
                    this._settings = this.account.groups_settings.create({name: attrs.name});
                }
                this.settings = this._settings.attributes;
                this.contacts = new xabber.GroupContacts(null, {group: this});
                this.settings_view = new xabber.GroupSettingsView({model: this});
                this.contacts.on("add update_contact_item", this.updateCounter, this);
                this.contacts.on("destroy", this.onContactRemoved, this);
                xabber._roster_settings.on("change", this.onChangedRosterSettings, this);
            },

            isSpecial: function () {
                return _.isNumber(this.get('id'));
            },

            updateCounter: function () {
                var all = this.contacts.length,
                    online = all - this.contacts.where({status: 'offline'}).length;
                this.set('counter', {all: all, online: online});
            },

            renameGroup: function (new_name) {
                var name = this.get('name'),
                    attrs = _.clone(this.settings);
                attrs.name = new_name;
                this._settings.destroy();
                this._settings = this.account.groups_settings.create(attrs);
                this.settings = this._settings.attributes;
                this.set({id: new_name, name: new_name});
                this.trigger('rename', this, name);
                _.each(_.clone(this.contacts.models), function (contact) {
                    var groups = _.clone(contact.get('groups')),
                        index = groups.indexOf(name);
                    if (index >= 0) {
                        groups.splice(index, 1);
                    }
                    index = groups.indexOf(new_name);
                    if (index < 0) {
                        groups.push(new_name);
                    }
                    contact.pushInRoster({groups: groups});
                });
            },

            deleteGroup: function () {
                var name = this.get('name');
                this._settings.destroy();
                _.each(_.clone(this.contacts.models), function (contact) {
                    var groups = _.clone(contact.get('groups')),
                        index = groups.indexOf(name);
                    if (index >= 0) {
                        groups.splice(index, 1);
                    }
                    contact.pushInRoster({groups: groups});
                });
            },

            removeContact: function (contact) {
                if (this.contacts.get(contact)) {
                    this.contacts.remove(contact);
                    this.onContactRemoved(contact);
                }
            },

            onContactRemoved: function (contact) {
                this.updateCounter();
                this.trigger('remove_contact', contact);
                this.contacts.length || this.destroy();
            },

            onChangedRosterSettings: function () {
                var changed = xabber._roster_settings.changed;
                if (_.has(changed, 'show_offline')) {
                    this._settings.trigger('change:show_offline');
                }
                if (_.has(changed, 'sorting')) {
                    this.contacts.sort();
                    this._settings.trigger('change:sorting');
                }
            },

            showSettings: function () {
                this.settings_view.show();
            }
        });

        xabber.GroupView = xabber.BasicView.extend({
            className: 'roster-group',
            events: {
                "click .group-head": "toggle",
                "click .group-head .group-icon": "showGroupSettings",
                "mouseover .group-head": "showSettingsIcon",
                "mouseleave .group-head": "updateGroupIcon"
            },

            _initialize: function () {
                this.account = this.model.account;
                this.updateName();
                this.updateGroupIcon();
                this.updateMembersCounter();
                this.model.contacts.on("add", this.onContactAdded, this);
                this.model.on("remove_contact", this.onContactRemoved, this);
                this.model.contacts.on("update_contact_item", this.updateContactItem, this);
                this.model.on("change:name", this.updateName, this);
                this.model.on("change:counter", this.updateMembersCounter, this);
                this.model._settings.on("change:show_offline", this.onChangedOfflineSetting, this);
                this.model._settings.on("change:sorting", this.onChangedSortingSetting, this);
                this.data.on("change:expanded", this.updateExpanded, this);
            },

            updateExpanded: function () {
                var expanded = this.data.get('expanded');
                this.$el.switchClass('shrank', !expanded);
                this.$('.arrow').switchClass('mdi-chevron-down', expanded);
                this.$('.arrow').switchClass('mdi-chevron-right', !expanded);
                this.$('.roster-contact').showIf(expanded);
                this.parent.parent.onListChanged();
            },

            updateGroupIcon: function () {
                var mdi_icon, show_offline = this.model.settings.show_offline;
                if (show_offline === 'default') {
                    mdi_icon = 'settings';
                } else if (show_offline === 'yes') {
                    mdi_icon = 'group-filled';
                } else if (show_offline === 'no') {
                    mdi_icon = 'group-outline';
                }
                this.$('.group-icon').attr('data-mdi', mdi_icon).hideIf(mdi_icon === 'settings');
            },

            updateName: function () {
                this.$('.group-name').text(this.model.get('name'));
            },

            updateMembersCounter: function () {
                var counter = this.model.get('counter');
                this.$('.participant-counter').text('('+counter.online+'/'+counter.all+')');
            },

            onContactAdded: function (contact) {
                var view = this.addChild(contact.get('jid'), this.item_view, {model: contact});
                this.updateContactItem(contact);
            },

            onContactRemoved: function (contact) {
                this.removeChild(contact.get('jid'));
                this.parent.parent.onListChanged();
            },

            updateContactItem: function (contact) {
                var view = this.child(contact.get('jid'));
                if (!view) return;
                var roster_settings = xabber.settings.roster,
                    group_settings = this.model.settings,
                    is_default_show_offline = group_settings.show_offline === 'default',
                    show_offline = group_settings.show_offline === 'yes' ||
                        (is_default_show_offline && roster_settings.show_offline === 'yes'),
                    is_offline = constants.STATUS_WEIGHTS[contact.get('status')] >= 6;

                view.$el.switchClass('invisible', is_offline && !show_offline).detach();
                var index = this.model.contacts.indexOf(contact);
                if (index === 0) {
                    this.$('.group-head').after(view.$el);
                } else {
                    this.$('.roster-contact').eq(index - 1).after(view.$el);
                }
                view.$el.showIf(this.data.get('expanded'));
                this.parent.parent.onListChanged();
                return view;
            },

            showSettingsIcon: function (ev) {
                this.$('.group-icon').attr('data-mdi', 'settings').removeClass('hidden');
            },

            showGroupSettings: function (ev) {
                ev.stopPropagation();
                this.model.showSettings();
            },

            onChangedOfflineSetting: function () {
                this.updateGroupIcon();
                var roster_settings = xabber.settings.roster,
                    group_settings = this.model.settings,
                    is_default_show_offline = group_settings.show_offline === 'default',
                    show_offline = group_settings.show_offline === 'yes' ||
                        (is_default_show_offline && roster_settings.show_offline === 'yes');
                _.each(this.children, function (view) {
                    var is_offline = constants.STATUS_WEIGHTS[view.model.get('status')] >= 6;
                    view.$el.switchClass('invisible', is_offline && !show_offline);
                });
                this.parent.parent.onListChanged();
            },

            onChangedSortingSetting: function () {
                _.each(this.children, function (view) { view.$el.detach(); });
                this.model.contacts.each(function (c) { this.updateContactItem(c); }.bind(this));
                this.parent.parent.onListChanged();
            }
        });

        xabber.GroupRightView = xabber.GroupView.extend({
            template: templates.group_right,
            item_view: xabber.ContactItemRightView,

            __initialize: function () {
                this.data.set('expanded', this.model.settings.expanded);
            },

            toggle: function () {
                var expanded = !this.data.get('expanded');
                this.data.set('expanded', expanded);
                this.model._settings.save('expanded', expanded);
            }
        });

        xabber.GroupLeftView = xabber.GroupView.extend({
            template: templates.group_left,
            item_view: xabber.ContactItemLeftView,

            __initialize: function () {
                this.data.set('expanded', true);
            },

            toggle: function (ev) {
                ev.stopPropagation();
                this.data.set('expanded', !this.data.get('expanded'));
            }
        });

        xabber.GroupSettingsView = xabber.BasicView.extend({
            className: 'modal main-modal group-settings',
            template: templates.group_settings,
            ps_selector: '.modal-content',
            avatar_size: constants.AVATAR_SIZES.GROUP_SETTINGS,

            events: {
                "change .offline input[type=radio][name=offline]": "setOffline",
                "click .btn-apply": "applySettings",
                "click .btn-delete": "deleteGroup",
                "click .btn-cancel": "close"
            },

            _initialize: function () {
                this._settings = this.model._settings;
                var name = this.model.get('name');
                if (this.model.isSpecial()) {
                    this.$('.group-name input').attr('readonly', true);
                    this.$('.btn-delete').addClass('hidden');
                }
                this.model.on("destroy", this.onDestroy, this);
            },

            render: function () {
                this.$('.group-name input').val(this.model.get('name'));
                this.$('.group-name .errors').addClass('hidden');
                this.$('.offline input[type=radio][name=offline][value='+
                    (this.model.settings.show_offline)+']').prop('checked', true);
                this.$el.openModal({
                    ready: function () {
                        Materialize.updateTextFields();
                    },
                    complete: this.hide.bind(this)
                });
            },

            setOffline: function (ev) {
                this.model._settings.save('show_offline', ev.target.value);
            },

            validateName: function (name) {
                if (!name) {
                    return 'Please input name!';
                }
                if (this.model.collection.get(name)) {
                    return 'Wrong name';
                }
            },

            applySettings: function () {
                var new_name = this.$('.group-name input').val();
                if (new_name !== this.model.get('name')) {
                    var name_error = this.validateName(new_name);
                    if (name_error) {
                        this.$('.group-name .errors').text(name_error).removeClass('hidden');
                        return;
                    } else {
                        this.model.renameGroup(new_name);
                    }
                }
                this.close();
            },

            deleteGroup: function () {
                var name = this.model.get('name');
                utils.dialogs.ask('Remove group', "Do you want to remove group "+name+"?", null, { ok_button_text: 'remove'})
                    .done(function (result) {
                        result && this.model.deleteGroup();
                    }.bind(this));
            },

            onHide: function () {
                this.$el.detach();
            },

            close: function () {
                this.$el.closeModal({ complete: this.hide.bind(this) });
            },

            onDestroy: function () {
                this.$el.closeModal({ complete: this.remove.bind(this) });
            }
        });

        xabber.Groups = Backbone.Collection.extend({
            model: xabber.Group,

            initialize: function (models, options) {
                this.account = options.account;
                this.on("add", this.onGroupAdded, this);
                this.on("change:id", this.sort, this);
            },

            comparator: function (a, b) {
                if (a.isSpecial() === b.isSpecial()) {
                    return a.get('id') < b.get('id') ? -1 : 1;
                }
                return a.isSpecial() ? 1 : -1;
            },

            notSpecial: function () {
                return this.filter(function (group) { return !group.isSpecial(); });
            },

            onGroupAdded: function (group) {
                group.acc_view = new xabber.AccountGroupView({model: group});
            }
        });

        xabber.Contacts = xabber.ContactsBase.extend({
            initialize: function (models, options) {
                this.account = options.account;
                this.account.on("deactivate destroy", this.removeAllContacts, this);
                this.collections = [];
                this.on("add", _.bind(this.updateInCollections, this, 'add'));
                this.on("change", _.bind(this.updateInCollections, this, 'change'));
            },

            addCollection: function (collection) {
                this.collections.push(collection);
            },

            updateInCollections: function (event, contact) {
                _.each(this.collections, function (collection) {
                    collection.update(contact, event);
                });
            },

            mergeContact: function (attrs) {
                if (typeof attrs !== "object") {
                    attrs = {jid: attrs};
                }
                var contact = this.get(attrs.jid);
                if (contact) {
                    contact.set(attrs);
                } else {
                    contact = this.create(attrs, {account: this.account});
                }
                return contact;
            },

            removeAllContacts: function () {
                _.each(_.clone(this.models), function (contact) {
                    contact.destroy();
                });
            },

            handlePresence: function (presence, jid) {
                var contact = this.mergeContact(jid);
                contact.handlePresence(presence);
            }
        });

        xabber.BlockList = xabber.ContactsBase.extend({
            initialize: function (models, options) {
                this.account = options.account;
                this.contacts = this.account.contacts;
                this.contacts.on("remove_from_blocklist", this.onContactRemoved, this);
            },

            update: function (contact, event) {
                var contains = contact.get('blocked');
                if (contains) {
                    if (!this.get(contact)) {
                        this.add(contact);
                        contact.trigger("add_to_blocklist", contact);
                    }
                } else if (this.get(contact)) {
                    this.remove(contact);
                    contact.trigger("remove_from_blocklist", contact);
                }
            },

            onContactRemoved: function (contact) {
                contact.getVCard();
            },

            registerHandler: function () {
                this.account.connection.deleteHandler(this._stanza_handler);
                this._stanza_handler = this.account.connection.addHandler(
                    this.onBlockingIQ.bind(this),
                    Strophe.NS.BLOCKING, 'iq', "set", null, this.account.get('jid')
                );
            },

            getFromServer: function () {
                var iq = $iq({type: 'get'}).c('blocklist', {xmlns: Strophe.NS.BLOCKING});
                this.account.sendIQ(iq, this.onBlockingIQ.bind(this));
            },

            onBlockingIQ: function (iq) {
                var $elem = $(iq).find('[xmlns="' + Strophe.NS.BLOCKING + '"]'),
                    tag = $elem[0].tagName.toLowerCase(),
                    blocked = tag.startsWith('block');
                $elem.find('item').each(function (idx, item) {
                    var jid = item.getAttribute('jid');
                    this.account.contacts.mergeContact({jid: jid, blocked: blocked});
                }.bind(this));
                return true;
            }
        });

        xabber.Roster = xabber.ContactsBase.extend({
            initialize: function (models, options) {
                this.account = options.account;
                this.roster_version = this.account.get('roster_version') || 0;
                this.groups = this.account.groups;
                this.contacts = this.account.contacts;
                this.contacts.on("add_to_roster", this.onContactAdded, this);
                this.contacts.on("change_in_roster", this.onContactChanged, this);
                this.contacts.on("remove_from_roster", this.onContactRemoved, this);
            },

            update: function (contact, event) {
                var contains = contact.get('in_roster') || contact.get('known');
                if (contains) {
                    if (!this.get(contact)) {
                        this.add(contact);
                        contact.trigger("add_to_roster", contact);
                    } else if (event === 'change') {
                        contact.trigger("change_in_roster", contact);
                    }
                } else if (this.get(contact)) {
                    this.remove(contact);
                    contact.trigger("remove_from_roster", contact);
                }
            },

            onContactAdded: function (contact) {
                if (!contact.get('in_roster')) {
                    this.addContactToGroup(contact, constants.NON_ROSTER_GROUP_ID);
                    return;
                }
                var groups = contact.get('groups');
                if (!groups.length) {
                    this.addContactToGroup(contact, constants.GENERAL_GROUP_ID);
                } else {
                    _.each(groups, _.bind(this.addContactToGroup, this, contact));
                }
            },

            onContactChanged: function (contact) {
                var changed = contact.changed,
                    known_changed = _.has(changed, 'known'),
                    in_roster_changed = _.has(changed, 'in_roster'),
                    groups_changed = _.has(changed, 'groups');
                if (in_roster_changed || known_changed || groups_changed) {
                    var groups;
                    if (contact.get('in_roster')) {
                        groups = _.clone(contact.get('groups'));
                        if (!groups.length) {
                            groups.push(constants.GENERAL_GROUP_ID);
                        }
                    } else if (contact.get('known')) {
                        groups = [constants.NON_ROSTER_GROUP_ID];
                    } else {
                        groups = [];
                    }
                    // TODO: optimize
                    var groups_to_remove = this.groups.filter(function (group) {
                        return !_.contains(groups, group.get('id'));
                    });
                    _.each(groups_to_remove, function (group) {
                        group.removeContact(contact);
                    });
                    _.each(groups, _.bind(this.addContactToGroup, this, contact));
                    contact.trigger('update_groups');
                }
            },

            onContactRemoved: function (contact) {
                _.each(this.groups.filter(), function (group) {
                    group.removeContact(contact);
                });
            },

            getGroup: function (name) {
                var group = this.groups.get(name);
                if (group) {
                    return group;
                }
                var attrs = {id: name};
                if (name === constants.GENERAL_GROUP_ID) {
                    attrs.name = xabber.settings.roster.general_group_name;
                } else if (name === constants.NON_ROSTER_GROUP_ID) {
                    attrs.name = xabber.settings.roster.non_roster_group_name;
                }
                return this.groups.create(attrs, {account: this.account});
            },

            addContactToGroup: function (contact, name) {
                var group = this.getGroup(name);
                group.contacts.add(contact);
            },

            registerHandler: function () {
                this.account.connection.deleteHandler(this._stanza_handler);
                this._stanza_handler = this.account.connection.addHandler(
                    this.onRosterIQ.bind(this),
                    Strophe.NS.ROSTER, 'iq', "set", null, this.account.get('jid')
                );
            },

            syncFromServer: function (options) {
                options = options || {};
                let request_attrs = {xmlns: Strophe.NS.SYNCHRONIZATION};
                (!options.after && this.account.last_msg_timestamp) && (request_attrs.stamp = this.account.last_msg_timestamp * 1000);
                let iq = $iq({type: 'get'}).c('query', request_attrs).cnode(new Strophe.RSM(options).toXML());
                this.account.sendIQ(iq, function (iq) {
                    this.onSyncIQ(iq, request_attrs.stamp);
                }.bind(this));
            },

            onSyncIQ: function (iq, request_with_stamp) {
                this.account.last_msg_timestamp = moment.now();
                let last_chat_msg_id = $(iq).find('set last');
                last_chat_msg_id.length ? (this.last_chat_msg_id = last_chat_msg_id.text()) : (this.conversations_loaded = true);
                if (!$(iq).find('conversation').length && !xabber.accounts.connected.find(account => !account.roster.conversations_loaded)) {
                    xabber.chats_view.$('.load-chats-feedback').text('All chats loaded');
                    return;
                }
                $(iq).find('conversation').each(function (idx, item) {
                    let $item = $(item),
                        jid = $item.attr('jid');
                    if (jid === this.account.get('jid')) {
                        return;
                    }
                    let contact = this.contacts.mergeContact(jid),
                        is_group_chat = $item.attr('type') === 'groupchat' ? true : false,
                        chat = this.account.chats.getChat(contact),
                        message = $item.children('last-message').children('message'),
                        current_call = $item.children('call'),
                        $unread_messages = $item.children('unread'),
                        last_delivered_msg = $item.children('delivered').attr('id'),
                        last_displayed_msg = $item.children('displayed').attr('id'),
                        unread_msgs_count = parseInt($unread_messages.attr('count')),
                        msg_retraction_version = $item.children('retract').attr('version'),
                        msg, options = {synced_msg: true};
                    contact.set('group_chat', is_group_chat);
                    if (current_call.length) {
                        let $jingle_message = current_call.children('message'),
                            full_jid = $jingle_message.attr('from'),
                            session_id = $jingle_message.children('propose').attr('id');
                        chat.initIncomingCall(full_jid, session_id);
                    }
                    if (!message.length) {
                        chat.set('timestamp', Math.trunc(Number($item.attr('stamp')))/1000);
                        chat.item_view.updateEmptyChat();
                    }
                    if (chat.message_retraction_version != msg_retraction_version) {
                        chat.message_retraction_version = msg_retraction_version;
                        request_with_stamp && chat.trigger("get_retractions_list");
                    }
                    chat.set('last_delivered_id', last_delivered_msg);
                    chat.set('last_displayed_id', last_displayed_msg);
                    unread_msgs_count && (options.is_unread = true);
                    options.delay = message.children('time');
                    unread_msgs_count && unread_msgs_count--;
                    message.length && (msg = this.account.chats.receiveChatMessage(message, options));
                    chat.set('const_unread', unread_msgs_count);
                    if (msg) {
                        if (!msg.isSenderMe() && ($unread_messages.attr('after') < msg.get('archive_id') || $unread_messages.attr('after') < msg.get('contact_archive_id')))
                            msg.set('is_unread', true);
                        chat.set('first_archive_id', msg.get('archive_id'));
                    }
                    xabber.toolbar_view.recountAllMessageCounter();
                }.bind(this));
                xabber.chats_view.hideChatsFeedback();
                return true;
            },

            getFromServer: function () {
                let request_ver = this.roster_version,
                    iq = $iq({type: 'get'}).c('query', {xmlns: Strophe.NS.ROSTER, ver: request_ver});
                this.account.sendIQ(iq, function (iq) {
                    this.onRosterIQ(iq);
                    this.account.sendPresence();
                    if (!$(iq).children('query').find('item').length)
                        this.account.cached_roster.getAllFromRoster(function (roster_items) {
                            $(roster_items).each(function (idx, roster_item) {
                                this.contacts.mergeContact(roster_item);
                            }.bind(this));
                            if (!roster_items.length && request_ver != 0) {
                                this.roster_version = 0;
                                this.getFromServer();
                            }
                        }.bind(this));
                    this.account.dfd_presence.resolve();
                }.bind(this));
            },

            onRosterIQ: function (iq) {
                let new_roster_version = $(iq).children('query').attr('ver');
                if (iq.getAttribute('type') === 'set') {
                    this.account.sendIQ($iq({
                        type: 'result', id: iq.getAttribute('id'),
                        from: this.account.jid
                    }));
                }
                else {
                    new_roster_version && (this.roster_version != new_roster_version) && this.account.cached_roster.clearDataBase();
                }
                new_roster_version && (this.roster_version = new_roster_version);
                this.account.save('roster_version', this.roster_version);
                $(iq).children('query').find('item').each(function (idx, item) {
                    this.onRosterItem(item);
                }.bind(this));
                return true;
            },

            onRosterItem: function (item) {
                var jid = item.getAttribute('jid');
                if (jid === this.account.get('jid')) {
                    return;
                }
                var contact = this.contacts.mergeContact(jid);
                var subscription = item.getAttribute("subscription");
                if (subscription === 'remove') {
                    contact.set({
                        in_roster: false,
                        known: false,
                        subscription: null
                    });
                    this.account.cached_roster.removeFromCachedRoster(jid);
                    return;
                }
                var groups = [];
                $(item).find('group').each(function () {
                    var group = $(this).text();
                    groups.indexOf(group) < 0 && groups.push(group);
                });
                var attrs = {
                    subscription: subscription,
                    in_roster: true,
                    roster_name: item.getAttribute("name"),
                    groups: groups
                };
                this.account.cached_roster.putInroster(_.extend(_.clone(attrs), {jid: jid}));
                attrs.roster_name && (attrs.name = attrs.roster_name);
                contact.set(attrs);
            }
        });

        xabber.AccountRosterView = xabber.BasicView.extend({
            className: 'account-roster-wrap',

            events: {
                "click .roster-account-info-wrap .status-button": "openChangeStatus",
                "click .roster-account-info": "toggle"
            },

            _initialize: function (options) {
                this.account = options.account;
                this.groups = this.account.groups;
                this.roster = this.account.roster;
                this.contacts = this.account.contacts;
                this.$el.attr('data-jid', this.account.get('jid'));
                this.$el.appendTo(this.parent.$('.contact-list'));
                this.$info = this.$('.roster-account-info-wrap');
                this.updateName();
                this.updateStatus();
                this.updateAvatar();
                this.updateColorScheme();
                this.account.on("change:name", this.updateName, this);
                this.account.on("change:image", this.updateAvatar, this);
                this.account.on("change:status_updated", this.updateStatus, this);
                this.account.settings.on("change:color", this.updateColorScheme, this);
                this.groups.on("add", this.onGroupAdded, this);
                this.groups.on("rename", this.onGroupRenamed, this);
                this.groups.on("destroy", this.onGroupRemoved, this);
                this.data.on("change:expanded", this.updateExpanded, this);
                this.data.set('expanded', true);
            },

            updateName: function () {
                this.$info.find('.name').text(this.account.get('name'));
            },

            updateStatus: function () {
                this.$info.find('.status').attr('data-status', this.account.get('status'));
                this.$info.find('.status-message').text(this.account.getStatusMessage());
            },

            updateAvatar: function () {
                var image = this.account.cached_image;
                this.$info.find('.circle-avatar').setAvatar(image, this.avatar_size);
            },

            updateColorScheme: function () {
                this.$el.attr('data-color', this.account.settings.get('color'));
            },

            updateExpanded: function () {
                var expanded = this.data.get('expanded');
                this.$el.switchClass('shrank', !expanded);
                this.parent.updateScrollBar();
            },

            updateGroupPosition: function (view) {
                view.$el.detach();
                var index = this.groups.indexOf(view.model);
                if (index === 0) {
                    this.$info.after(view.$el);
                } else {
                    this.$('.roster-group').eq(index - 1).after(view.$el);
                }
                this.parent.updateScrollBar();
            },

            onGroupAdded: function (group) {
                var view = this.addChild(group.get('id'), this.group_view, {model: group});
                this.updateGroupPosition(view);
            },

            onGroupRenamed: function (group, old_name) {
                var view = this.child(old_name);
                delete this.children[old_name];
                this.children[group.get('name')] = view;
                view && this.updateGroupPosition(view);
            },

            onGroupRemoved: function (group) {
                this.removeChild(group.get('id'));
            },

            toggle: function (ev) {
                this.data.set('expanded', !this.data.get('expanded'));
            },

            openChangeStatus: function (ev) {
                xabber.change_status_view.open(this.account);
            }
        });

        xabber.AccountRosterRightView = xabber.AccountRosterView.extend({
            template: templates.account_roster_right,
            group_view: xabber.GroupRightView,
            avatar_size: constants.AVATAR_SIZES.ROSTER_RIGHT_ACCOUNT_ITEM,

            __initialize: function () {
                this.contacts.on("add_to_roster change_in_roster remove_from_roster",
                    this.updateCounter, this);
                this.contacts.on("add_to_roster remove_from_roster",
                    this.updateGlobalCounter, this);
            },

            updateCounter: function (contact) {
                var all = this.roster.length,
                    online = all - this.roster.where({status: 'offline'}).length;
                this.$info.find('.counter').text(online + '/' + all);
            },

            updateGlobalCounter: function (contact) {
                this.parent.updateCounter();
            }
        });

        xabber.AccountRosterLeftView = xabber.AccountRosterView.extend({
            template: templates.account_roster_left,
            group_view: xabber.GroupLeftView,
            avatar_size: constants.AVATAR_SIZES.ROSTER_LEFT_ACCOUNT_ITEM,

            __initialize: function () {
                this.$info.find('.jid').text(this.account.get('jid'));
            },

            search: function (query) {
                this.$el.removeClass('shrank');
                this.$('.group-head').addClass('hidden');
                var count = 0, hashes = {};
                this.$('.roster-contact').each(function (idx, item) {
                    var $item = $(item),
                        jid = $item.data('jid'),
                        contact = this.roster.get(jid);
                    if (!contact) return;
                    if (hashes[contact.hash_id]) {
                        $item.addClass('hidden');
                        return;
                    }
                    hashes[contact.hash_id] = true;
                    var name = contact.get('name').toLowerCase(),
                        hide = name.indexOf(query) < 0 && jid.indexOf(query) < 0;
                    $item.hideIf(hide);
                    hide || count++;
                }.bind(this));
                this.$('.roster-account-info-wrap').showIf(count);
            },

            searchAll: function () {
                this.$el.switchClass('shrank', !this.data.get('expanded'));
                this.$('.roster-account-info-wrap').removeClass('hidden');
                this.$('.group-head').removeClass('hidden');
                this.$('.list-item').removeClass('hidden');
            }
        });

        xabber.BlockedItemView = xabber.BasicView.extend({
            className: 'blocked-contact',
            template: templates.contact_blocked_item,
            avatar_size: constants.AVATAR_SIZES.CONTACT_BLOCKED_ITEM,

            events: {
                "click .btn-unblock": "unblockContact",
                "click": "showDetails"
            },

            _initialize: function (options) {
                this.$el.appendTo(this.parent.$('.blocked-contacts'));
                this.$el.attr({'data-jid': this.model.get('jid')});
                this.$('.jid').text(this.model.get('jid'));
                this.$('.circle-avatar').setAvatar(this.model.cached_image, this.avatar_size);
            },

            unblockContact: function (ev) {
                ev.stopPropagation();
                this.model.unblock();
            },

            showDetails: function (ev) {
                this.model.showDetails();
            }
        });

        xabber.BlockListView = xabber.BasicView.extend({
            _initialize: function (options) {
                this.account = options.account;
                this.account.contacts.on("add_to_blocklist", this.onContactAdded, this);
                this.account.contacts.on("remove_from_blocklist", this.onContactRemoved, this);
            },

            onContactAdded: function (contact) {
                if (!contact.get('group_chat')) {
                    this.addChild(contact.get('jid'), xabber.BlockedItemView, {model: contact});
                    this.$('.placeholder').addClass('hidden');
                    this.parent.updateScrollBar();
                }
            },

            onContactRemoved: function (contact) {
                this.removeChild(contact.get('jid'));
                this.$('.placeholder').hideIf(this.account.blocklist.length);
                this.parent.updateScrollBar();
            }
        });

        xabber.RosterView = xabber.SearchPanelView.extend({
            ps_selector: '.contact-list-wrap',

            _initialize: function () {
                this._settings = xabber._roster_settings;
                this.model.on("activate", this.updateOneRosterView, this);
                this.model.on("update_order", this.updateRosterViews, this);
                this.model.on("deactivate destroy", this.removeRosterView, this);
                this.on("before_hide", this.saveScrollBarOffset, this);
            },

            updateOneRosterView: function (account) {
                var jid = account.get('jid'),
                    view = this.child(jid);
                if (view) {
                    view.$el.detach();
                } else if (account.isConnected()) {
                    view = this.addChild(jid, this.account_roster_view, {account: account});
                } else {
                    return;
                }
                var index = this.model.connected.indexOf(account);
                if (index === 0) {
                    this.$('.contact-list').prepend(view.$el);
                } else {
                    this.$('.contact-list').children().eq(index - 1).after(view.$el);
                }
                this.updateScrollBar();
            },

            updateRosterViews: function () {
                _.each(this.children, function (view) { view.detach(); });
                this.model.each(function (account) {
                    var jid = account.get('jid'), view = this.child(jid);
                    view && this.$('.contact-list').append(view.$el);
                }.bind(this));
                this.updateScrollBar();
            },

            removeRosterView: function (account) {
                this.removeChild(account.get('jid'));
                this.updateScrollBar();
            }
        });

        xabber.RosterRightView = xabber.RosterView.extend({
            className: 'roster-right-container container',
            template: templates.roster_right,
            ps_settings: {theme: 'roster-right'},
            account_roster_view: xabber.AccountRosterRightView,

            events: {
                "mouseover .collapsed-wrap": "expand",
                "mouseleave .expanded-wrap": "collaps",
                "click .btn-pin": "pinUnpin"
            },

            __initialize: function () {
                this.updateCounter();
                this.model.on("activate deactivate destroy", this.updateCounter, this);
                this.data.on("change", this.updateLayout, this);
                var pinned = this._settings.get('pinned');
                this.data.set({expanded: pinned, pinned: pinned});
            },

            expand: function () {
                this.data.set('expanded', true);
            },

            collaps: function () {
                if (!this.data.get('pinned')) {
                    this.data.set('expanded', false);
                }
            },

            pinUnpin: function () {
                var pinned = !this.data.get('pinned');
                this._settings.save('pinned', pinned);
                this.data.set('pinned', pinned);
            },

            updateLayout: function () {
                var changed = this.data.changed;
                if (_.has(changed, 'expanded') || _.has(changed, 'pinned')) {
                    xabber.trigger('update_layout', {roster_state_changed: true});
                }
            },

            updateCounter: function () {
                this.$('.all-contacts-counter').text(
                    _.reduce(this.children, function (counter, view) {
                        return counter + view.roster.length;
                    }, 0)
                );
            },

            onListChanged: function () {
                this.updateScrollBar();
            }
        });

        xabber.RosterLeftView = xabber.RosterView.extend({
            className: 'roster-left-container container',
            template: templates.roster_left,
            ps_settings: {theme: 'item-list'},
            main_container: '.contact-list',
            account_roster_view: xabber.AccountRosterLeftView,

            __initialize: function () {
                this.model.on("list_changed", this.updateLeftIndicator, this);
                this.ps_container.on("ps-scroll-y", this.onScrollY.bind(this));
            },

            updateLeftIndicator: function () {
                this.$el.attr('data-indicator', this.model.connected.length > 1);
            },

            getContactForItem: function (item) {
                var $item = $(item),
                    account_jid = $item.parent().parent().data('jid'),
                    jid = $item.data('jid'),
                    roster_view = this.child(account_jid);
                return roster_view && roster_view.roster.get(jid);
            },

            render: function (options) {
                (options.right !== 'chat' && options.right !== 'contact_details' && options.right !== 'message_context' && options.right !== 'participant_messages' || options.clear_search && options.right === 'chat') && this.clearSearch();
            },

            searchAll: function () {
                _.each(this.children, function (view) {
                    view.searchAll();
                });
            },

            selectItem: function (id, arrow) {
                if (!id) {
                    (arrow === 'up') && (this.ps_container[0].scrollTop = 0);
                    return;
                }
                this.clearSearchSelection();
                var $selection = this.$('.list-item[data-id="'+id+'"]');
                if ($selection.length) {
                    this.selection_id = id;
                } else {
                    this.ps_container[0].scrollTop = 0;
                    $selection = this.$('.list-item:visible').first();
                    this.selection_id = $selection.data('id');
                }
                if ($selection.length && arrow === 'down' && ($selection[0].clientHeight + $selection[0].offsetTop + $selection.parent()[0].offsetTop + $selection.closest('.account-roster-wrap')[0].offsetTop >= this.ps_container[0].clientHeight + this.ps_container[0].scrollTop
                || $selection[0].clientHeight + $selection[0].offsetTop + $selection.parent()[0].offsetTop + $selection.closest('.account-roster-wrap')[0].offsetTop < this.ps_container[0].scrollTop))
                    this.ps_container[0].scrollTop = $selection[0].offsetTop + $selection.parent()[0].offsetTop + $selection.closest('.account-roster-wrap')[0].offsetTop;
                if ($selection.length && arrow === 'up' && ($selection[0].offsetTop + $selection.parent()[0].offsetTop + $selection.closest('.account-roster-wrap')[0].offsetTop <= this.ps_container[0].scrollTop
                || $selection[0].offsetTop + $selection.parent()[0].offsetTop + $selection.closest('.account-roster-wrap')[0].offsetTop > this.ps_container[0].scrollTop + this.ps_container[0].clientHeight))
                    this.ps_container[0].scrollTop = $selection[0].offsetTop + $selection.parent()[0].offsetTop + $selection.closest('.account-roster-wrap')[0].offsetTop;
                $selection.addClass('selected');
            },

            onEnterPressed: function (selection) {
                let view;
                if (selection.closest('.searched-lists-wrap').length) {
                    this.clearSearch();
                    this.$('.list-item.active').removeClass('active');
                    if (selection.hasClass('chat-item')) {
                        view = xabber.chats_view.child(selection.data('id'));
                        view && view.open({screen: xabber.body.screen.get('name'), clear_search: false});
                        selection.addClass('active');
                    }
                    if (selection.hasClass('roster-contact')) {
                        view = xabber.accounts.get(selection.data('account')).chats.get(xabber.accounts.get(selection.data('account')).contacts.get(selection.data('jid')).hash_id);
                        view && (view = view.item_view);
                        view && xabber.chats_view.openChat(view, {clear_search: false, screen: xabber.body.screen.get('name')});
                        selection.addClass('active');
                    }
                    if (selection.hasClass('message-item')) {
                        selection.click();
                    }
                }
                else {
                    var contact = this.getContactForItem(selection);
                    contact && contact.showDetails();
                }
            },

            onListChanged: function () {
                this.updateSearch();
            }
        });

        xabber.RosterSettingsView = xabber.BasicView.extend({
            className: 'roster-settings-wrap',
            template: templates.roster_settings,

            events: {
                "change .offline-contacts input": "setOfflineSetting",
                "change .sorting-contacts input": "setSortingSetting"
            },

            _initialize: function () {
                this.$el.appendTo(this.parent.$('.settings-block-wrap.contact-list'));
            },

            render: function () {
                this.$('.offline-contacts input[type=radio][name=offline-contacts][value='+
                    (this.model.get('show_offline'))+']').prop('checked', true);
                this.$('.sorting-contacts input[type=radio][name=sorting-contacts][value='+
                    (this.model.get('sorting'))+']').prop('checked', true);
            },

            setOfflineSetting: function () {
                this.model.save('show_offline',
                    this.$('.offline-contacts input[type=radio][name=offline-contacts]:checked').val());
            },

            setSortingSetting: function () {
                this.model.save('sorting',
                    this.$('.sorting-contacts input[type=radio][name=sorting-contacts]:checked').val());
            }
        });

        xabber.AccountGroupView = xabber.BasicView.extend({
            className: 'group',
            template: function () {
                this.$el.append('<span class="group-name"/>');
            },

            events: {
                "click .group-name": "showGroupSettings"
            },

            _initialize: function (options) {
                this.$('.group-name').text(this.model.get('name'));
                var index = this.model.collection.indexOf(this.model),
                    $parent_el = this.model.account.settings_right.$('.groups');
                if (index === 0) {
                    $parent_el.prepend(this.$el);
                } else {
                    $parent_el.children().eq(index - 1).after(this.$el);
                }
                this.model.on("destroy", this.remove, this);
            },

            showGroupSettings: function () {
                this.model.showSettings();
            }
        });

        xabber.ContactPlaceholderView = xabber.BasicView.extend({
            className: 'placeholder-wrap contact-placeholder-wrap noselect',
            template: templates.contact_placeholder
        });

        xabber.AddContactView = xabber.BasicView.extend({
            className: 'modal main-modal add-contact-modal',
            template: templates.add_contact,
            ps_selector: '.modal-content',
            avatar_size: constants.AVATAR_SIZES.SYNCHRONIZE_ACCOUNT_ITEM,

            events: {
                "click .account-field .dropdown-content": "selectAccount",
                "click .existing-group-field label": "editGroup",
                "change .new-group-name input": "checkNewGroup",
                "keyup .new-group-name input": "checkNewGroup",
                "keyup .name-field #new_contact_username": "checkJid",
                "focusout .name-field #new_contact_username": "focusoutInputField",
                "click .new-group-checkbox": "addNewGroup",
                "click .btn-add": "addContact",
                "click .btn-cancel": "close"
            },

            _initialize: function () {
                this.group_data = new Backbone.Model;
                this.group_data.on("change", this.updateGroups, this);
            },

            render: function (options) {
                if (!xabber.accounts.connected.length) {
                    utils.dialogs.error('No connected accounts found.');
                    return;
                }
                options || (options = {});
                var accounts = options.account ? [options.account] : xabber.accounts.connected,
                    jid = options.jid || '';
                this.$('input[name="username"]').val(jid).attr('readonly', !!jid)
                    .removeClass('invalid');
                this.$('.single-acc').showIf(accounts.length === 1);
                this.$('.multiple-acc').hideIf(accounts.length === 1);
                this.$('.account-field .dropdown-content').empty();
                _.each(accounts, function (account) {
                    this.$('.account-field .dropdown-content').append(
                        this.renderAccountItem(account));
                }.bind(this));
                this.bindAccount(accounts[0]);
                this.$('span.errors').text('');
                this.$el.openModal({
                    ready: function () {
                        Materialize.updateTextFields();
                        this.$('.account-field .dropdown-button').dropdown({
                            inDuration: 100,
                            outDuration: 100,
                            constrainWidth: false,
                            hover: false,
                            alignment: 'left'
                        });
                    }.bind(this),
                    complete: this.hide.bind(this)
                });
                return this;
            },

            bindAccount: function (account) {
                this.account = account;
                this.$('.account-field .dropdown-button .account-item-wrap')
                    .replaceWith(this.renderAccountItem(account));
                this.renderGroupsForAccount(account);
            },

            renderAccountItem: function (account) {
                var $item = $(templates.add_contact_account_item({jid: account.get('jid')}));
                $item.find('.circle-avatar').setAvatar(account.cached_image, this.avatar_size);
                return $item;
            },

            renderGroupsForAccount: function (account) {
                this.group_data.set({
                    selected: [],
                    groups: _.map(account.groups.notSpecial(), function (group) {
                        return group.get('name');
                    })
                }, {silent: true});
                this.updateGroups();
            },

            updateGroups: function () {
                var selected = this.group_data.get('selected');
                this.$('.groups').html(templates.groups_checkbox_list({
                    groups: _.map(this.group_data.get('groups'), function (name) {
                        return { name: name, id: uuid(), checked: _.contains(selected, name) };
                    })
                }));
                this.updateScrollBar();
            },

            selectAccount: function (ev) {
                var $item = $(ev.target).closest('.account-item-wrap'),
                    account = xabber.accounts.get($item.data('jid'));
                this.bindAccount(account);
            },

            editGroup: function (ev) {
                ev.preventDefault();
                var $target = $(ev.target),
                    $input = $target.siblings('input'),
                    checked = !$input.prop('checked'),
                    group_name = $input.attr('data-groupname'),
                    selected = _.clone(this.group_data.get('selected')),
                    idx = selected.indexOf(group_name);
                $input.prop('checked', checked);
                if (checked) {
                    idx < 0 && selected.push(group_name);
                } else if (idx >= 0) {
                    selected.splice(idx, 1);
                }
                this.group_data.set('selected', selected);
            },

            checkNewGroup: function (ev) {
                var name = $(ev.target).val(),
                    $checkbox = this.$('.new-group-checkbox');
                $checkbox.showIf(name && !_.contains(this.group_data.get('groups'), name));
            },

            addNewGroup: function (ev) {
                ev.preventDefault();
                var $input = this.$('.new-group-name input'),
                    name = $input.val(),
                    groups = _.clone(this.group_data.get('groups')),
                    idx = groups.indexOf(name);
                if (idx < 0) {
                    var selected = _.clone(this.group_data.get('selected'));
                    selected.push(name);
                    groups.push(name);
                    this.group_data.set({groups: groups, selected: selected});
                }
                this.scrollToBottom();
            },

            focusoutInputField: function () {
                if (!this.$('input[name=username]').val().trim()) {
                    this.$('input[name=username]').removeClass('invalid');
                    this.$('span.errors').text('').addClass('hidden');
                }
            },

            checkJid: function () {
                let jid = this.$('input[name=username]').val().trim(),
                    error_text,
                    regexp_full_jid = /^(([^<>()[\]\\.,;:\s%@\"]+(\.[^<>()[\]\\.,;:\s%@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([^<>()[\]\\.,;:\s%@\"]+(\.[^<>()[\]\\.,;:\s%@\"]+)*)|(\".+\"))|(([0-9]{1,3}\.){3}[0-9]{1,3})|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
                if (!regexp_full_jid.test(jid) && jid) {
                    error_text = 'Invalid jid';
                }
                if (error_text) {
                    this.$('input[name=username]').addClass('invalid')
                        .siblings('.errors').text(error_text);
                }
                else {
                    this.$('input[name=username]').removeClass('invalid');
                    this.$('span.errors').text('').addClass('hidden');
                }
            },

            addContact: function () {
                this.$('span.errors').text('').addClass('hidden');
                var jid = this.$('input[name=username]').removeClass('invalid').val().trim(),
                    name = this.$('input[name=contact_name]').removeClass('invalid').val(),
                    groups = this.group_data.get('selected'),
                    contact, error_text,
                    regexp_full_jid = /^(([^<>()[\]\\.,;:\s%@\"]+(\.[^<>()[\]\\.,;:\s%@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([^<>()[\]\\.,;:\s%@\"]+(\.[^<>()[\]\\.,;:\s%@\"]+)*)|(\".+\"))|(([0-9]{1,3}\.){3}[0-9]{1,3})|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
                jid = Strophe.getBareJidFromJid(jid);
                if (!jid) {
                    error_text = 'Input username!';
                } else if (jid === this.account.get('jid')) {
                    error_text = 'Can not add yourself to contacts!';
                } else if (!regexp_full_jid.test(jid)) {
                    error_text = 'Invalid jid';
                }
                else {
                    contact = this.account.contacts.mergeContact(jid);
                    if (contact.get('in_roster')) {
                        error_text = 'Contact is already in your roster!';
                    }
                }
                if (error_text) {
                    this.$('input[name=username]').addClass('invalid')
                        .siblings('.errors').text(error_text);
                } else {
                    contact.pres('subscribed');
                    contact.pushInRoster({name: name, groups: groups}, function () {
                        contact.pres('subscribe');
                        contact.trigger("open_chat", contact);
                    }.bind(this), function () {
                        contact.destroy();
                    });
                    this.close();
                }
            },

            onHide: function () {
                this.$el.detach();
            },

            close: function () {
                this.$el.closeModal({ complete: this.hide.bind(this) });
            }
        });

        xabber.GroupSettings = Backbone.Model.extend({
            idAttribute: 'name',
            defaults: {
                expanded: true,
                show_offline: 'default',
                sorting: 'default',
                custom_notifications: false,
                notifications: false,
                message_preview: false
            }
        });

        xabber.GroupsSettings = Backbone.CollectionWithStorage.extend({
            model: xabber.GroupSettings,

            _initialize: function (models, options) {
                this.account = options.account;
                this.account.on("destroy", this.clearStorage, this);
                this.fetch();
            }
        });

        xabber.RosterSettings = Backbone.ModelWithStorage.extend({
            defaults: {
                pinned: true,
                show_offline: 'yes',
                sorting: 'online-first',
                general_group_name: 'General',
                non_roster_group_name: 'Not in roster'
            }
        });

        xabber.CachedContactsInfo = Backbone.ModelWithDataBase.extend({
            defaults: {
                contacts: []
            },

            putContactInfo: function (value, callback) {
                this.database.put('contacts', value, function (response_value) {
                    callback && callback(response_value);
                });
            },

            getContactInfo: function (value, callback) {
                this.database.get('contacts', value, function (response_value) {
                    callback && callback(response_value);
                });
            }
        });

        xabber.CachedRoster = Backbone.ModelWithDataBase.extend({
            putInroster: function (value, callback) {
                this.database.put('roster_items', value, function (response_value) {
                    callback && callback(response_value);
                });
            },

            getItemFromRoster: function (value, callback) {
                this.database.get('roster_items', value, function (response_value) {
                    callback && callback(response_value);
                });
            },

            getAllFromRoster: function (callback) {
                this.database.get_all('roster_items', null, function (response_value) {
                    callback && callback(response_value || []);
                });
            },

            removeFromCachedRoster: function (value, callback) {
                this.database.remove('roster_items', value, function (response_value) {
                    callback && callback(response_value);
                });
            },

            clearDataBase: function () {
                this.database.clear_database('roster_items');
            }
        });

        xabber.Account.addInitPlugin(function () {
            this.groups_settings = new xabber.GroupsSettings(null, {
                account: this,
                storage_name: xabber.getStorageName() + '-groups-settings-' + this.get('jid')
            });
            this.cached_roster = new xabber.CachedRoster(null, {
                name:'cached-roster-list-' + this.get('jid'),
                objStoreName: 'roster_items',
                primKey: 'jid'
            });

            this.groupchat_settings = new xabber.GroupChatSettings({id: 'group-chat-settings'}, {
                account: this,
                storage_name: xabber.getStorageName() + '-group-chat-settings-' + this.get('jid'),
                fetch: 'after'
            });
            this.groups = new xabber.Groups(null, {account: this});
            this.contacts = new xabber.Contacts(null, {account: this});
            this.contacts.addCollection(this.roster = new xabber.Roster(null, {account: this}));
            this.contacts.addCollection(this.blocklist = new xabber.BlockList(null, {account: this}));

            this.settings_right.addChild('blocklist', xabber.BlockListView,
                {account: this, el: this.settings_right.$('.blocklist-info')[0]});

            this._added_pres_handlers.push(this.contacts.handlePresence.bind(this.contacts));

            this.on("ready_to_get_roster", function () {
                this.resources.reset();
                this.contacts.each(function (contact) {
                    contact.resources.reset();
                    contact.resetStatus();
                });
                if (this.connection && this.connection.do_synchronization) {
                    let options = {};
                    !this.roster.last_chat_msg_id && (options.max = 20);
                    this.roster.syncFromServer(options);
                }
                this.roster.getFromServer();
                this.blocklist.getFromServer();
            }, this);
        });

        xabber.Account.addConnPlugin(function () {
            this.registerIQHandler();
            this.roster.registerHandler();
            this.blocklist.registerHandler();
        }, true, true);

        xabber.once("start", function () {
            this._roster_settings = new this.RosterSettings({id: 'roster-settings'},
                {storage_name: this.getStorageName(), fetch: 'after'});
            this.settings.roster = this._roster_settings.attributes;
            this.roster_settings_view = xabber.settings_view.addChild(
                'roster_settings', this.RosterSettingsView, {model: this._roster_settings});
            this.cached_contacts_info = new xabber.CachedContactsInfo(null, {
                name:'cached-contacts-list',
                objStoreName: 'contacts',
                primKey: 'jid'
            });
            this.contacts_view = this.left_panel.addChild('contacts', this.RosterLeftView,
                {model: this.accounts});
            this.roster_view = this.body.addChild('roster', this.RosterRightView,
                {model: this.accounts});
            this.details_container = this.right_panel.addChild('details', this.Container);
            this.contact_placeholder = this.right_panel.addChild('contact_placeholder',
                this.ContactPlaceholderView);
            this.add_contact_view = new this.AddContactView();
            this.on("add_contact", function () {
                this.add_contact_view.show();
            }, this);
        }, xabber);

        return xabber;
    };
});
