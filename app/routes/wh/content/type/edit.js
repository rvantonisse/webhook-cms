import SearchIndex from 'appkit/utils/search-index';

export default Ember.Route.extend({

  beforeModel: function (transition) {

    var EditRoute = this;
    var promises = [];

    var itemId = transition.params['wh.content.type.edit'] && transition.params['wh.content.type.edit'].item_id;

    var contentType = this.modelFor('wh.content.type');
    var modelName = contentType.get('itemModelName');

    if (itemId) {
      var lockRef   = window.ENV.firebase.child('presence/locked').child(modelName).child(itemId);

      var userEmail = this.get('session.user.email');

      var lockCheck = new Ember.RSVP.Promise(function (resolve, reject) {
        lockRef.once('value', function (snapshot) {
          var lock = snapshot.val();
          Ember.Logger.log('lockCheck done');
          if (lock && typeof lock === 'object' && lock.email !== userEmail) {
            // check for expired lock
            if (moment(lock.time).diff(moment()) > 0) {
              reject(new Ember.Error(lock.email + ' is already editing this item.'));
            } else {
              resolve();
            }
          } else {
            resolve();
          }
        });
      }).then(function () {

        // Unlock on disconnect
        lockRef.onDisconnect().remove();

        EditRoute.addObserver('lockUntil', EditRoute.updateLock);

        EditRoute.set('lockUntil', moment().add(2, 'minutes').format());

        return EditRoute.store.find(modelName, itemId).then(function (item) {

          // item found
          EditRoute.set('itemModel', item);

          if (item.get('itemData.publish_date') && !contentType.get('canPublish')) {
            contentType.get('controls').setEach('disabled', true);
          } else if (Ember.isEmpty(item.get('itemData.publish_date')) && contentType.get('canDraft')) {
            contentType.get('controls').setEach('disabled', false);
          }

        }, function (message) {

          // item does not exist

          // create the item if we're a one-off
          if (EditRoute.modelFor('wh.content.type').get('oneOff')) {

            // hack to overwrite empty state model that is being put in store from find method
            var item = EditRoute.store.getById(modelName, contentType.get('id'));
            item.loadedData();

            EditRoute.set('itemModel', item);

            return Ember.RSVP.resolve(item);

          } else {

            lockRef.remove();
            return Ember.RSVP.reject(new Ember.Error(itemId + ' does not exist.'));

          }

        });

      });

      promises.push(lockCheck);

      this.set('lockRef', lockRef);
      this.set('itemId', itemId);

    }

    promises.push(this.modelFor('wh.content.type').verifyControls());

    return Ember.RSVP.Promise.all(promises).catch(function (error) {
      window.alert(error.message);
      var contentType = this.modelFor('wh.content.type');
      if (contentType.get('oneOff')) {
        this.transitionTo('wh');
      } else {
        this.transitionTo('wh.content.type', contentType);
      }
    }.bind(this));
  },

  updateLock: function () {

    var lockUntil = this.get('lockUntil');

    if (Ember.isEmpty(lockUntil)) {
      return;
    }

    this.get('lockRef').set({
      email: this.get('session.user.email'),
      time: lockUntil
    });

    var EditRoute = this;
    var incrementLockTime = Ember.run.later(function () {
      EditRoute.set('lockUntil', moment().add(2, 'minutes').format());
    }, 60000);

    this.set('incrementLockTime', incrementLockTime);

  },

  model: function (params) {
    return this.modelFor('wh.content.type');
  },

  setupController: function (controller, type) {

    this._super.apply(this, arguments);

    var route = this;

    this.set('dupeNameError', 'Name must be unique among ' + type.get('name') + ' entries.');

    controller.set('showSchedule', false);
    controller.set('itemModel', this.get('itemModel'));
    controller.set('isNew', !this.get('itemId'));
    controller.set('initialRelations', Ember.Object.create());

    var data = this.getWithDefault('itemModel.itemData', {});

    type.get('controls').forEach(function (control) {
      control.setValue(data[control.get('name')]);
    });

    var slugControl = type.get('controls').findBy('name', 'slug');
    controller.set('slugControl', slugControl);
    controller.set('isEditingSlug', false);
    slugControl.set('initialValue', this.get('itemModel.initialSlug'));

    type.get('controls').filterBy('controlType.widget', 'relation').filterBy('value').forEach(function (control) {
      controller.get('initialRelations').set(control.get('name'), Ember.copy(control.get('value')));
    });

    // Disable related controls you do not have permission to access
    var permissions = this.get('session.user.permissions');
    type.get('controls').filterBy('controlType.widget', 'relation').forEach(function (control) {

      var relatedTypeId = control.get('meta.contentTypeId');

      if (permissions && (permissions.get(relatedTypeId) === 'none' || permissions.get(relatedTypeId) === 'view')) {
        control.set('disabled', true);
      }
    });

    // Use search to check for duplicate names
    var nameControl = type.get('controls').findBy('name', 'name');
    controller.set('nameControl', nameControl);

    if (type.get('oneOff')) {
      controller.set('isDraft', null);
    } else {
      controller.set('publishDate', type.get('controls').findBy('name', 'publish_date').get('value'));
      controller.set('isDraft', data.isDraft || !controller.get('publishDate'));
    }

    controller.set('type', type);

    controller.set('previewUrl', null);

    // watch for value changes so we can prevent user from accidentally leaving
    controller.set('initialValues', type.get('controls').getEach('value'));
  },

  actions: {
    willTransition: function (transition) {

      if (this.get('controller.isDirty') && !window.confirm('You have changes that have not been saved, are you sure you would like to leave?')) {
        transition.abort();
        return;
      }

      this.get('controller').removeObserver('type.controls.@each.value');
      this.set('controller.isDirty', false);

      this.get('controller.type.controls').findBy('name', 'name').removeObserver('value');
      this.set('isObservingName', false);


      // Unlock on transition
      this.removeObserver('lockUntil', this.updateLock);
      this.set('lockUntil', null);
      if (this.get('lockRef')) {
        this.get('lockRef').remove();
      }

      return true;
    }
  }
});
