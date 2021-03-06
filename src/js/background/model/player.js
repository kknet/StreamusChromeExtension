define([
    'background/enum/chromeCommand',
    'common/enum/playerState',
    'common/enum/youTubeQuality'
], function (ChromeCommand, PlayerState, YouTubeQuality) {
    'use strict';

    var Player = Backbone.Model.extend({
        localStorage: new Backbone.LocalStorage('Player'),

        defaults: function () {
            return {
                //  Need to set the ID for Backbone.LocalStorage
                id: 'Player',
                //  Returns the elapsed time of the currently loaded song. Returns 0 if no song is playing
                currentTime: 0,
                //  API will fire a 'ready' event after initialization which indicates the player can now respond accept commands
                ready: false,
                loading: false,
                currentLoadAttempt: 1,
                //  TODO: maxLoadAttempts isn't DRY with YouTubePlayer.
                maxLoadAttempts: 10,
                state: PlayerState.Unstarted,
                //  This will be set after the player is ready and can communicate its true value.
                //  Default to 50 because having the music on and audible, but not blasting, seems like the best default if we fail for some reason.
                volume: 50,
                maxVolume: 100,
                minVolume: 0,
                //  This will be set after the player is ready and can communicate its true value.
                muted: false,
                loadedSong: null,
                playImmediately: false,
                songToActivate: null,

                //  Suffix alarm with unique identifier to prevent running after browser closed & re-opened.
                //  http://stackoverflow.com/questions/14101569/chrome-extension-alarms-go-off-when-chrome-is-reopened-after-time-runs-out
                refreshAlarmName: 'refreshAlarm_' + _.now(),

                settings: null,
                youTubePlayer: null
            };
        },
        
        //  Don't want to save everything to localStorage -- only variables which need to be persisted.
        whitelist: ['muted', 'volume'],
        toJSON: function () {
            return this.pick(this.whitelist);
        },
        
        //  Initialize the player by creating a YouTube Player IFrame hosting an HTML5 player
        initialize: function () {
            this.on('change:volume', this._onChangeVolume);
            this.on('change:muted', this._onChangeMuted);
            this.on('change:ready', this._onChangeReady);
            this.on('change:loading', this._onChangeLoading);
            this.on('change:state', this._onChangeState);

            this.listenTo(this.get('settings'), 'change:songQuality', this._onChangeSongQuality);
            this.listenTo(this.get('youTubePlayer'), 'change:ready', this._onYouTubePlayerChangeReady);
            this.listenTo(this.get('youTubePlayer'), 'change:state', this._onYouTubePlayerChangeState);
            this.listenTo(this.get('youTubePlayer'), 'youTubeError', this._onYouTubePlayerError);
            this.listenTo(this.get('youTubePlayer'), 'change:loading', this._onYouTubePlayerChangeLoading);
            this.listenTo(this.get('youTubePlayer'), 'change:currentLoadAttempt', this._onYouTubePlayerChangeCurrentLoadAttempt);
            this.listenTo(Streamus.channels.player.commands, 'playOnActivate', this._playOnActivate);

            chrome.runtime.onConnect.addListener(this._onChromeRuntimeConnect.bind(this));
            chrome.commands.onCommand.addListener(this._onChromeCommandsCommand.bind(this));
            chrome.alarms.onAlarm.addListener(this._onChromeAlarmsAlarm.bind(this));

            this._ensureInitialState();
        },
        
        activateSong: function (song, timeInSeconds) {
            if (this.get('ready')) {
                var playerState = this.get('state');
                var playOnActivate = this.get('playOnActivate');

                var videoOptions = {
                    videoId: song.get('id'),
                    startSeconds: timeInSeconds || 0,
                    //  The variable is called suggestedQuality because the widget may not have be able to fulfill the request.
                    //  If it cannot, it will set its quality to the level most near suggested quality.
                    suggestedQuality: YouTubeQuality.fromSongQuality(this.get('settings').get('songQuality'))
                };

                //  TODO: I don't think I *always* want to keep the player going if a song is activated while one is playing, but maybe...
                if (playOnActivate || playerState === PlayerState.Playing || playerState === PlayerState.Buffering) {
                    this.get('youTubePlayer').loadVideoById(videoOptions);
                } else {
                    this.get('youTubePlayer').cueVideoById(videoOptions);
                }

                this.set({
                    loadedSong: song,
                    //  It's helpful to keep currentTime set here because the progress bar in foreground might be visually set,
                    //  but until the song actually loads -- current time isn't set.
                    currentTime: timeInSeconds || 0,
                    playOnActivate: false,
                    songToActivate: null
                });
            } else {
                this.set('songToActivate', song);
            }
        },
        
        toggleState: function () {
            var playing = this.get('state') === PlayerState.Playing;
            playing ? this.pause() : this.play();
        },
        
        setVolume: function (volume) {
            var maxVolume = this.get('maxVolume');
            var minVolume = this.get('minVolume');
            
            if (volume > maxVolume) {
                volume = maxVolume;
            }
            else if (volume < minVolume) {
                volume = minVolume;
            }

            this.save({
                muted: false,
                volume: volume
            });
        },

        stop: function () {
            this.get('youTubePlayer').stop();

            this.set({
                loadedSong: null,
                currentTime: 0
            });
        },

        pause: function () {
            this.get('youTubePlayer').pause();
        },
            
        play: function () {
            if (this.get('youTubePlayer').get('ready')) {
                this.get('youTubePlayer').play();
            } else {
                this.set('playOnActivate', true);
                this.get('youTubePlayer').preload();
            }
        },

        seekTo: function (timeInSeconds) {
            if (this.get('ready')) {
                var state = this.get('state');

                //  TODO: I'd like to ensure the Player is always in the 'paused' state because seekTo will start playing
                //  if called when in the Unstarted or SongCued state.
                if (state === PlayerState.Unstarted || state === PlayerState.SongCued) {
                    this.activateSong(this.get('loadedSong'), timeInSeconds);
                } else {
                    this.get('youTubePlayer').seekTo(timeInSeconds);
                }
            } else {
                this.set('currentTime', timeInSeconds);
            }
        },
        
        watchInTab: function (song) {
            var url = song.get('url');

            if (this.get('loadedSong') === song) {
                url += '?t=' + this.get('currentTime') + 's';
            }

            chrome.tabs.create({
                url: url
            });

            this.pause();
        },
        
        refresh: function () {
            this._clearRefreshAlarm();

            var loadedSong = this.get('loadedSong');
            if (loadedSong !== null) {
                this.activateSong(loadedSong, this.get('currentTime'));
            }
        },
        
        //  Ensure that the initial state of the player properly reflects the state of its APIs
        _ensureInitialState: function () {
            this.set('ready', this.get('youTubePlayer').get('ready'));
            this.set('loading', this.get('youTubePlayer').get('loading'));
            //  TODO: How will I handle currentLoadAttempt w/ 2+ APIs? If both are loading they could be on separate attempts...?
            this.set('currentLoadAttempt', this.get('youTubePlayer').get('currentLoadAttempt'));
        },

        //  Attempt to set playback quality to songQuality or highest possible.
        _onChangeSongQuality: function (model, songQuality) {
            var youTubeQuality = YouTubeQuality.fromSongQuality(songQuality);
            this.get('youTubePlayer').setPlaybackQuality(youTubeQuality);
        },
        
        //  Update the volume whenever the UI modifies the volume property.
        _onChangeVolume: function (model, volume) {
            if (this.get('ready')) {
                this.get('youTubePlayer').setVolume(volume);
            } else {
                this.get('youTubePlayer').preload();
            }
        },
        
        _onChangeMuted: function (model, muted) {
            if (this.get('ready')) {
                muted ? this.get('youTubePlayer').mute() : this.get('youTubePlayer').unMute();
            } else {
                this.get('youTubePlayer').preload();
            }
        },
        
        _onChangeState: function(model, state) {
            if (state === PlayerState.Playing || state === PlayerState.Buffering) {
                this._clearRefreshAlarm();
            } else {
                this._createRefreshAlarm();
            }
        },
        
        _onChangeReady: function (model, ready) {
            if (ready) {
                //  Load from Backbone.LocalStorage
                this.fetch();
                //  These values need to be set explicitly because the 'change' event handler won't fire if localStorage value is the same as default.
                this.get('youTubePlayer').setVolume(this.get('volume'));
                this.get('muted') ? this.get('youTubePlayer').mute() : this.get('youTubePlayer').unMute();

                //  If an 'activateSong' command came in while the player was not ready, fulfill it now. 
                var songToActivate = this.get('songToActivate');
                if (songToActivate !== null) {
                    this.activateSong(songToActivate);
                } else {
                    //  Otherwise, ensure that the currently active song is loaded into its respective API player.
                    this.refresh();
                }
            } else {
                this._clearRefreshAlarm();
            }
        },
        
        _onChangeLoading: function(model, loading) {
            //  Ensure player doesn't start playing a song when recovering from a bad state after a long period of time.
            //  It is OK to start playback again when recovering initially, but not OK if recovering hours later.
            if (!loading && !this.get('ready')) {
                var state = this.get('loadedSong') === null ? PlayerState.Unstarted : PlayerState.Paused;
                this.set('state', state);
            }
        },
        
        _onChromeRuntimeConnect: function (port) {
            if (port.name === 'youTubeIFrameConnectRequest') {
                port.onMessage.addListener(this._onYouTubeIFrameMessage.bind(this));
            }
        },
        
        _onYouTubeIFrameMessage: function (message) {
            //  It's better to be told when time updates rather than poll YouTube's API for the currentTime.
            if (!_.isUndefined(message.currentTime)) {
                this.set('currentTime', message.currentTime);
            }

            //  YouTube's API for seeking/buffering doesn't fire events reliably.
            //  Listen directly to the element for more responsive results.
            if (!_.isUndefined(message.seeking)) {
                if (message.seeking) {
                    if (this.get('state') === PlayerState.Playing) {
                        this.set('state', PlayerState.Buffering);
                    }
                } else {
                    if (this.get('state') === PlayerState.Buffering) {
                        this.set('state', PlayerState.Playing);
                    }
                }
            }
            
            if (!_.isUndefined(message.error)) {
                var error = new Error(message.error);
                Streamus.channels.error.commands.trigger('log:error', error);
            }
        },

        _onChromeCommandsCommand: function (command) {
            if (command === ChromeCommand.IncreaseVolume) {
                var increasedVolume = this.get('volume') + 5;
                this.setVolume(increasedVolume);
            }
            else if (command === ChromeCommand.DecreaseVolume) {
                var decreasedVolume = this.get('volume') - 5;
                this.setVolume(decreasedVolume);
            }
        },
        
        _onChromeAlarmsAlarm: function (alarm) {
            //  Check the alarm name because closing the browser will not clear an alarm, but new alarm name is generated on open.
            if (alarm.name === this.get('refreshAlarmName')) {
                this.refresh();
            }
        },
        
        _onYouTubePlayerChangeReady: function (model, ready) {
            //  TODO: This will need to be smarter w/ SoundCloud support.
            this.set('ready', ready);
        },
        
        _onYouTubePlayerChangeState: function (model, state) {
            //  TODO: This will need to be smarter w/ SoundCloud support.
            this.set('state', state);
        },
        
        _onYouTubePlayerChangeLoading: function (model, loading) {
            //  TODO: This will need to be smarter w/ SoundCloud support.
            this.set('loading', loading);
        },
        
        _onYouTubePlayerChangeCurrentLoadAttempt: function (model, currentLoadAttempt) {
            //  TODO: This will need to be smarter w/ SoundCloud support.
            this.set('currentLoadAttempt', currentLoadAttempt);
        },
        
        //  TODO: In the future this should probably be generic and just emit an error which isn't tied to YouTube.
        //  Emit errors so the foreground so can notify the user.
        _onYouTubePlayerError: function (model, error) {
            this.trigger('youTubeError', this, error);
        },
        
        _createRefreshAlarm: function () {
            if (!this.get('refreshAlarmCreated')) {
                this.set('refreshAlarmCreated', true);
                chrome.alarms.create(this.get('refreshAlarmName'), {
                    //  Wait 6 hours
                    delayInMinutes: 360.0
                });
            }
        },
        
        //  TODO: Reconsider pause logic. It's possible for someone to juggle a single song between playing/not playing for long enough that
        //  it would still expire. It would be better to keep the timer always going as long as the song is loaded and if it pauses with the timer exceeded
        //  or is paused when the timer exceeds, reload.
        _clearRefreshAlarm: function () {
            if (this.get('refreshAlarmCreated')) {
                this.set('refreshAlarmCreated', false);
                chrome.alarms.clear(this.get('refreshAlarmName'));
            }
        },
        
        _playOnActivate: function (playOnActivate) {
            this.set('playOnActivate', playOnActivate);
        }
    });

    return Player;
});