'use strict';

const Utils = require('./../utils');
const Helpers = require('./helpers');
const _ = require('lodash');
const Transaction = require('../transaction');
const Association = require('./base');
const Op = require('../operators');

/**
 * One-to-one association
 *
 * In the API reference below, add the name of the association to the method, e.g. for `User.belongsTo(Project)` the getter will be `user.getProject()`.
 *
 * @see {@link Model.belongsTo}
 */
class BelongsTo extends Association {
  constructor(source, target, options) {
    super(source, target, options);

    this.associationType = 'BelongsTo';
    this.isSingleAssociation = true;
    this.foreignKeys = null;
    this.targetKeys = null;

    if (this.as) {
      this.isAliased = true;
      this.options.name = {
        singular: this.as,
      };
    } else {
      this.as = this.target.options.name.singular;
      this.options.name = this.target.options.name;
    }

    if (
      (Array.isArray(this.options.foreignKey) || Array.isArray(this.options.targetKey)) &&
      (!Array.isArray(this.options.foreignKey) ||
        !Array.isArray(this.options.targetKey) ||
        this.options.foreignKey.length !== this.options.targetKey.length)
    ) {
      throw new Error(
        'targetKey must be array of equal length when foreignKey is an array, and vice versa',
      );
    }

    if (Array.isArray(this.options.foreignKey)) {
      this.foreignKeys = this.options.foreignKey.map(
        foreignKey => (_.isObject(foreignKey) ? foreignKey : { name: foreignKey }),
      );
      if (
        !Array.isArray(this.options.targetKey) ||
        this.options.foreignKey.length !== this.options.targetKey.length
      ) {
      }
    } else if (_.isObject(this.options.foreignKey)) {
      const name = this.options.foreignKey.name || this._getDefaultForeignKeyName();
      this.foreignKeys = [_.defaults({}, this.options.foreignKey, { name })];
    } else if (this.options.foreignKey) {
      this.foreignKeys = [
        {
          name: this.options.foreignKey,
        },
      ];
    }

    if (!this.foreignKeys) {
      this.foreignKeys = [
        {
          name: this._getDefaultForeignKeyName(),
        },
      ];
    }

    this.identifiers = this.foreignKeys;

    this.identifierFields = this.identifiers
      .filter(identifier => !!this.source.rawAttributes[identifier])
      .map(identifier => this.source.rawAttributes[identifier].field || identifier);

    if (Array.isArray(this.options.targetKey)) {
      this.targetKeys = this.options.targetKey;
    } else {
      this.targetKeys = [this.options.targetKey || this.target.primaryKeyAttribute];
    }

    this.targetKeyFields = this.targetKeys.map(
      targetKey => this.target.rawAttributes[targetKey].field || targetKey,
    );

    this.singlePrimaryTargetKey =
      this.targetKeys.length === 1 && this.targetKeys[0] === this.target.primaryKeyAttribute
        ? this.foreignKeys[0].name
        : null;

    this.associationAccessor = this.as;
    this.options.useHooks = options.useHooks;

    // Get singular name, trying to uppercase the first letter, unless the model forbids it
    const singular = Utils.uppercaseFirst(this.options.name.singular);

    this.accessors = {
      get: `get${singular}`,
      set: `set${singular}`,
      create: `create${singular}`,
    };
  }

  // the id is in the source table
  injectAttributes() {
    const newAttributes = {};

    this.foreignKeys.forEach((foreignKey, index) => {
      const targetKey = this.targetKeys[index];
      const targetKeyField = this.targetKeyFields[index];

      if (!targetKey) {
        throw new Error('Missing target key', foreignKey);
      }
      const newAttribute = _.defaults({}, foreignKey, {
        type: this.options.keyType || this.target.rawAttributes[targetKey].type,
        allowNull: true,
      });
      newAttributes[foreignKey.name] = newAttribute;

      Helpers.addForeignKeyConstraints(
        newAttribute,
        this.target,
        this.source,
        this.options,
        targetKeyField,
      );
    });

    // TODO
    // if (this.options.constraints !== false) {
    //   const source = this.source.rawAttributes[this.foreignKey] || newAttributes[this.foreignKey];
    //   this.options.onDelete = this.options.onDelete || (source.allowNull ? 'SET NULL' : 'NO ACTION');
    //   this.options.onUpdate = this.options.onUpdate || 'CASCADE';
    // }

    Utils.mergeDefaults(this.source.rawAttributes, newAttributes);

    // TODO
    // this.identifierField = this.source.rawAttributes[this.foreignKey].field || this.foreignKey;

    this.source.refreshAttributes();

    Helpers.checkNamingCollision(this);

    return this;
  }

  mixin(obj) {
    const methods = ['get', 'set', 'create'];

    Helpers.mixinMethods(this, obj, methods);
  }

  /**
   * Get the associated instance.
   *
   * @param {Object} [options]
   * @param {String|Boolean} [options.scope] Apply a scope on the related model, or remove its default scope by passing false.
   * @param {String} [options.schema] Apply a schema on the related model
   * @see {@link Model.findOne} for a full explanation of options
   * @return {Promise<Model>}
   */
  get(instances, options) {
    const association = this;
    const where = {};
    let Target = association.target;
    let instance;

    options = Utils.cloneDeep(options);

    if (options.hasOwnProperty('scope')) {
      if (!options.scope) {
        Target = Target.unscoped();
      } else {
        Target = Target.scope(options.scope);
      }
    }

    if (options.hasOwnProperty('schema')) {
      Target = Target.schema(options.schema, options.schemaDelimiter);
    }

    if (!Array.isArray(instances)) {
      instance = instances;
      instances = undefined;
    }

    if (instances) {
      association.foreignKeys.forEach((foreignKey, index) => {
        where[association.targetKeys[index]] = {
          [Op.in]: instances.map(instance => instance.get(foreignKey.name)),
        };
      });
    } else if (association.singlePrimaryTargetKey && !options.where) {
      return Target.findById(instance.get(association.singlePrimaryTargetKey), options);
    } else {
      association.foreignKeys.forEach((foreignKey, index) => {
        where[association.targetKeys[index]] = instance.get(foreignKey.name);
      });
      options.limit = null;
    }

    options.where = options.where ? { [Op.and]: [where, options.where] } : where;

    if (instances) {
      return Target.findAll(options).then(results => {
        const result = {};
        for (const instance of instances) {
          result[instance.get(association.foreignKey, { raw: true })] = null;
        }

        for (const instance of results) {
          result[instance.get(association.targetKey, { raw: true })] = instance;
        }

        return result;
      });
    }

    return Target.findOne(options);
  }

  /**
   * Set the associated model.
   *
   * @param {Model|String|Number} [newAssociation] An persisted instance or the primary key of an instance to associate with this. Pass `null` or `undefined` to remove the association.
   * @param {Object} [options] Options passed to `this.save`
   * @param {Boolean} [options.save=true] Skip saving this after setting the foreign key if false.
   * @return {Promise}
   */
  set(sourceInstance, associatedInstance, options) {
    const association = this;

    options = options || {};

    let value = associatedInstance;
    if (associatedInstance instanceof association.target) {
      value = associatedInstance[association.targetKey];
    }

    sourceInstance.set(association.foreignKey, value);

    if (options.save === false) return;

    options = _.extend(
      {
        fields: [association.foreignKey],
        allowNull: [association.foreignKey],
        association: true,
      },
      options,
    );

    // passes the changed field to save, so only that field get updated.
    return sourceInstance.save(options);
  }

  /**
   * Create a new instance of the associated model and associate it with this.
   *
   * @param {Object} [values]
   * @param {Object} [options] Options passed to `target.create` and setAssociation.
   * @see {@link Model#create}  for a full explanation of options
   * @return {Promise}
   */
  create(sourceInstance, values, fieldsOrOptions) {
    const association = this;

    const options = {};

    if ((fieldsOrOptions || {}).transaction instanceof Transaction) {
      options.transaction = fieldsOrOptions.transaction;
    }
    options.logging = (fieldsOrOptions || {}).logging;

    return association.target
      .create(values, fieldsOrOptions)
      .then(newAssociatedObject =>
        sourceInstance[association.accessors.set](newAssociatedObject, options),
    );
  }

  _getDefaultForeignKeyName() {
    return Utils.camelizeIf(
      [
        Utils.underscoredIf(this.as, this.source.options.underscored),
        this.target.primaryKeyAttribute,
      ].join('_'),
      !this.source.options.underscored,
    );
  }
}

module.exports = BelongsTo;
module.exports.BelongsTo = BelongsTo;
module.exports.default = BelongsTo;
