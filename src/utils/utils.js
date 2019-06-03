define([
    "xabber-dependencies",
    "xabber-emoji-utils",
    "xabber-image-utils",
    "xabber-modal-utils",
    "xabber-textarea-utils"
], function (deps, emoji, images, modals, textarea) {
    var $ = deps.$,
        _ = deps._,
        moment = deps.moment;

    // jQuery extensions
    $.fn.switchClass = function (klass, condition) {
        if (arguments.length === 1) {
            condition = !this.hasClass(klass);
        }
        if (condition) {
            this.addClass(klass);
        } else {
            this.removeClass(klass);
        }
        return this;
    };

    $.fn.showIf = function (condition) {
        return this.switchClass('hidden', !condition);
    };

    $.fn.hideIf = function (condition) {
        return this.switchClass('hidden', condition);
    };

    var getHyperLink = function (url) {
        var prot = (url.indexOf('http://') === 0 ||  url.indexOf('https://') === 0) ? '' : 'http://',
            escaped_url = encodeURI(decodeURI(url)).replace(/[!'()]/g, escape).replace(/\*/g, "%2A");
        return "<a target='_blank' class='msg-hyperlink' href='"+prot+escaped_url + "'>"+url+"</a>";
    };

    $.fn.hyperlinkify = function (options) {
        options || (options = {});
        var $query = options.selector ? this.find(options.selector) : this;
        $query.each(function (i, obj) {
            var $obj = $(obj),
                x = $obj.html(),
                url_regexp = /(((ftp|http|https):\/\/)|(www\.))(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-\/]))?/g,
                list = x.match(url_regexp);
            if (!list) {
                return;
            }
            if (list.length === 1 && list[0] === x) {
                $obj.html(getHyperLink(x));
            } else {
                for (i = 0; i < list.length; i++) {
                    x = x.replace(list[i], getHyperLink(list[i]));
                }
                $obj.html(x);
            }
        });
        return this;
    };

    var utils = {
        uuid: function () {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0,
                    v = c == 'x' ? r : r & 0x3 | 0x8;
                return v.toString(16);
            });
        },

        utoa: function (str) {
            return window.btoa(unescape(encodeURIComponent(str)));
        },

        atou: function (str) {
            return decodeURIComponent(escape(window.atob(str)));
        },

        now: function () {
            return Math.floor(moment.now() / 1000);
        },

        pretty_time: function (timestamp) {
            var datetime = timestamp ? moment(timestamp) : moment();
            return datetime.format('HH:mm:ss');
        },

        pretty_date: function (timestamp) {
            var datetime = timestamp ? moment(timestamp) : moment();
            return datetime.format('dddd, MMMM D, YYYY');
        },

        pretty_datetime: function (timestamp) {
            var datetime = timestamp ? moment(timestamp) : moment();
            return datetime.format('MMMM D, YYYY HH:mm:ss');
        },

        pretty_short_datetime: function (timestamp) {
            var datetime = timestamp ? moment(timestamp) : moment(),
                day = moment(datetime).startOf('day'),
                year = moment(datetime).startOf('year');
            if (day.isSame(moment().startOf('day'))) {
                return datetime.format('HH:mm:ss');
            } else if (year.isSame(moment().startOf('year'))) {
                return datetime.format('MMM D');
            } else {
                return datetime.format('DD/MM/gg');
            }
        },

        pretty_short_month_date: function (timestamp) {
            var datetime = timestamp ? moment(timestamp) : moment(),
                day = moment(datetime).startOf('day'),
                year = moment(datetime).startOf('year');
            if (day.isSame(moment().startOf('day'))) {
                return datetime.format('HH:mm:ss');
            } else if (year.isSame(moment().startOf('year'))) {
                return datetime.format('MMM D, YYYY HH:mm:ss');
            } else {
                return datetime.format('DD/MM/gg, HH:mm:ss');
            }
        },

        pretty_timedelta: function (seconds) {
            if (seconds < 60) {
                return 'just now';
            }
            if (seconds < 3600) {
                return Math.floor(seconds / 60) + ' minutes ago';
            }
            if (seconds < 86400) {
                return Math.floor(seconds / 3600) + ' hours ago';
            }
            return Math.floor(seconds / 86400) + ' days ago';
        },

        pretty_size: function (size) {
            if (size < 1024) {
                return size+' B';
            } else if (size < 1048576) {
                return (size/1024).toFixed(2)+' KB';
            } else if (size < 1073741824) {
                return (size/1048576).toFixed(2)+' MB';
            } else {
                return (size/1073741824).toFixed(2)+' GB';
            }
        },

        pretty_last_seen: function (seconds) {
            if ((seconds >= 0)&&(seconds < 60))
                return 'last seen just now';
            if ((seconds > 60)&&(seconds < 3600))
                return ('last seen ' + Math.trunc(seconds/60) + ((seconds < 120) ? ' minute ago' : ' minutes ago'));
            if ((seconds >= 3600)&&(seconds < 7200))
                return ('last seen hour ago');
            if ((seconds >= 3600*48*2))
                return ('last seen '+ moment().subtract(seconds, 'seconds').format('LL'));
            else
                return ('last seen '+ (moment().subtract(seconds, 'seconds').calendar()).toLowerCase());
        },

        pretty_duration: function (duration) {
            if (_.isUndefined(duration))
                return undefined;
            if (duration < 10)
                return ("0:0" + duration);
            if (duration < 60)
                return ("0:" + duration);
            if (duration > 60)
                return (Math.trunc(duration/60) + ":" + ((duration%60 < 10) ? ("0" + (duration%60)) : duration%60));
        },

        pretty_name: function (name) {
            return name[0].toUpperCase() + name.replace(/-/,' ').substr(1);
        },

        slice_string: function (str, from, to) {
            to = _.isNumber(to) ? to : [...str].length;
            if (str.length === [...str].length)
                return str.slice(from, to);
            else
                return Array.from(str).slice(from, to).join("");
        },

        slice_pretty_body: function (body, legacy_refs) {
            let pretty_body = Array.from(body);
            legacy_refs && legacy_refs.forEach(function (legacy_ref) {
                for (let idx = legacy_ref.start; idx <= legacy_ref.end; idx++)
                    pretty_body[idx] = "";
            }.bind(this));
            return pretty_body.join("");
        },

        markupBodyMessage: function (message) {
            let attrs = _.clone(message.attributes),
                body = attrs.original_message || attrs.message,
                mentions = attrs.mentions || [],
                markups = attrs.markups || [],
                legacy_refs = attrs.legacy_content || [],
                markup_body = Array.from(_.escape(_.unescape(body)));

            mentions.concat(markups).forEach(function (markup) {
                let start_idx = markup.start,
                    end_idx = markup.end,
                    mark_up = markup.markups || [],
                    mention = markup.uri || "";
                if (mark_up.length) {
                    let start_tags = "",
                        end_tags = "";
                    mark_up.forEach(function (mark_up_style) {
                        start_tags = '<' + mark_up_style[0].toLowerCase() + '>' + start_tags;
                        end_tags += '</' + mark_up_style[0].toLowerCase() + '>';
                    }.bind(this));
                    markup_body[start_idx] = start_tags + markup_body[start_idx];
                    markup_body[end_idx] += end_tags;
                }
                else {
                    markup_body[start_idx] = '<span data-id="' + (mention.lastIndexOf('?id=') > -1 ? mention.slice(mention.lastIndexOf('?id=') + 4) : mention) + '" class="mention ground-color-100">' + markup_body[start_idx];
                    markup_body[end_idx] += '</span>';
                }
            }.bind(this));

            legacy_refs.forEach(function (legacy) {
                for (let idx = legacy.start; idx <= legacy.end; idx++)
                    markup_body[idx] = "";
            }.bind(this));

            return markup_body.join("");
        },

        copyTextToClipboard: function(text, callback_msg, errback_msg) {
            if (!window.navigator.clipboard) {
                return;
            }
            window.navigator.clipboard.writeText(text).then(function() {
                if (callback_msg) {
                    let info_msg = callback_msg;
                    this.callback_popup_message(info_msg, 1500);
                }
            }.bind(this), function() {
                if (errback_msg) {
                    let info_msg = errback_msg;
                    this.callback_popup_message(info_msg, 1500);
                }
            }.bind(this));
        },

        callback_popup_message: function (info_msg, time) {
            let $body = $(document.body),
                $popup_msg = $('<div class="callback-popup-message"/>').text(info_msg);
            $body.find('.callback-popup-message').remove();
            $body.append($popup_msg);
            setTimeout( function() {
                $popup_msg.remove();
            }, time);
        },

        openWindow: function (url, errback) {
            let win = window.open(url, '_blank');
            if (win) {
                win.focus();
            } else {
                errback && errback();
            }
        },

        clearSelection: function () {
            var selection = window.getSelection();
            if (selection.empty) {
                selection.empty();
            } else if (selection.removeAllRanges) {
                selection.removeAllRanges();
            }
        },

        isMobile: {
            Android: function () {
                return navigator.userAgent.match(/Android/i);
            },
            BlackBerry: function () {
                return navigator.userAgent.match(/BlackBerry/i);
            },
            iOS: function () {
                return navigator.userAgent.match(/iPhone|iPad|iPod/i);
            },
            Opera: function () {
                return navigator.userAgent.match(/Opera Mini/i);
            },
            Windows: function () {
                return navigator.userAgent.match(/IEMobile/i) || navigator.userAgent.match(/WPDesktop/i);
            },
            any: function () {
                return (this.Android() || this.BlackBerry() || this.iOS() || this.Opera() || this.Windows());
            }
        },

        emoji: emoji,
        images: images,
        modals: modals,
        dialogs: modals.dialogs
    };

    return utils;
});
