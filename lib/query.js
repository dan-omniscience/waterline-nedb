
/**
 * Module dependencies
 */

var _ = require('lodash');

/**
 * Query Constructor
 *
 * Normalizes Waterline queries to work with TingoDB.
 *
 * @param {Object} options
 * @api private
 */

var Query = module.exports = function Query(options, schema) {

  // Cache the schema for use in parseTypes
  this.schema = schema;

  // Normalize Criteria
  this.criteria = this.normalizeCriteria(options);

  return this;
};

/**
 * Normalize Criteria
 *
 * Transforms a Waterline Query into a query that can be used
 * with TingoDB. For example it sets '>' to $gt, etc.
 *
 * @param {Object} options
 * @return {Object}
 * @api private
 */

Query.prototype.normalizeCriteria = function normalizeCriteria(options) {
  "use strict";
  var self = this;

  return _.mapValues(options, function (original, key) {
    if (key === 'where') return self.parseWhere(original);
    if (key === 'sort')  return self.parseSort(original);
    return original;
  });
};


/**
 * Parse Where
 *
 * <where> ::= <clause>
 *
 * @api private
 *
 * @param original
 * @returns {*}
 */
Query.prototype.parseWhere = function parseWhere(original) {
  "use strict";
  var self = this;

  // Fix an issue with broken queries when where is null
  if(_.isNull(original)) return {};

  return self.parseClause(original);
};


/**
 * Parse Clause
 *
 * <clause> ::= { <clause-pair>, ... }
 *
 * <clause-pair> ::= <field> : <expression>
 *                 | or|$or: [<clause>, ...]
 *                 | $or   : [<clause>, ...]
 *                 | $and  : [<clause>, ...]
 *                 | $nor  : [<clause>, ...]
 *                 | like  : { <field>: <expression>, ... }
 *
 * @api private
 *
 * @param original
 * @returns {*}
 */
Query.prototype.parseClause = function parseClause(original) {
  "use strict";
  var self = this;

  return _.reduce(original, function parseClausePair(obj, val, key) {
    "use strict";

    // Normalize `or` key into tingo $or
    if (key.toLowerCase() === 'or') key = '$or';

    // handle Logical Operators
    if (['$or', '$and', '$nor'].indexOf(key) !== -1) {
      // Value of $or, $and, $nor require an array, else ignore
      if (_.isArray(val)) {
        val = _.map(val, function (clause) {
          return self.parseClause(clause);
        });

        obj[key] = val;
      }
    }

    // handle Like Operators for WQL (Waterline Query Language)
    else if (key.toLowerCase() === 'like') {
      // transform `like` clause into multiple `like` operator expressions
      _.extend(obj, _.reduce(val, function parseLikeClauses(likes, expression, field) {
        likes[field] = self.parseExpression(field, { like: expression });
        return likes;
      }, {}));
    }

    // Default
    else {
      // Normalize `id` key into tingo `_id`
      if (key === 'id' && !_.has(this, '_id')) key = '_id';
      
      val = self.parseExpression(key, val);


      obj[key] = val;
    }

    return obj;
  }, {}, original);
};


/**
 * Parse Expression
 *
 * <expression> ::= { <!|not>: <value> | [<value>, ...] }
 *                | { <$not>: <expression>, ... }
 *                | { <modifier>: <value>, ... }
 *                | [<value>, ...]
 *                | <value>

 * @api private
 *
 * @param field
 * @param expression
 * @returns {*}
 */
Query.prototype.parseExpression = function parseExpression(field, expression) {
  "use strict";
  var self = this;

  // Recursively parse nested unless value is a date
  if (_.isPlainObject(expression) && !_.isDate(expression)) {
    return _.reduce(expression, function (obj, val, modifier) {

      // Handle `not` by transforming to $not, $ne or $nin
      if (modifier === '!' || modifier.toLowerCase() === 'not') {

        if (_.isPlainObject(val) && !_.has(val, '_bsontype')) {
          obj['$not'] = self.parseExpression(field, val);
          return obj;
        }

        modifier = _.isArray(val) ? '$nin' : '$ne';
        val = self.parseValue(field, modifier, val);
        obj[modifier] = val;
        return obj;
      }

      // WQL Evaluation Modifiers for String
      if (_.isString(val)) {
        // Handle `contains` by building up a case insensitive regex
        if(modifier === 'contains') {
          val = utils.caseInsensitive(val);
          val =  '.*' + val + '.*';
          return new RegExp('^' + val + '$', 'i');
        }

        // Handle `like`
        if(modifier === 'like') {
          val = utils.caseInsensitive(val);
          val = val.replace(/%/g, '.*');
          return new RegExp('^' + val + '$', 'i');
        }

        // Handle `startsWith` by setting a case-insensitive regex
        if(modifier === 'startsWith') {
          val = utils.caseInsensitive(val);
          val =  val + '.*';
          return new RegExp('^' + val + '$', 'i');
        }

        // Handle `endsWith` by setting a case-insensitive regex
        if(modifier === 'endsWith') {
          val = utils.caseInsensitive(val);
          val =  '.*' + val;
          return new RegExp('^' + val + '$', 'i');
        }
      }

      // Handle `lessThan` by transforming to $lt
      if(modifier === '<' || modifier === 'lessThan' || modifier.toLowerCase() === 'lt') {
        obj['$lt'] = self.parseValue(field, modifier, val);
        return obj;
      }

      // Handle `lessThanOrEqual` by transforming to $lte
      if(modifier === '<=' || modifier === 'lessThanOrEqual' || modifier.toLowerCase() === 'lte') {
        obj['$lte'] = self.parseValue(field, modifier, val);
        return obj;
      }

      // Handle `greaterThan` by transforming to $gt
      if(modifier === '>' || modifier === 'greaterThan' || modifier.toLowerCase() === 'gt') {
        obj['$gt'] = self.parseValue(field, modifier, val);
        return obj;
      }

      // Handle `greaterThanOrEqual` by transforming to $gte
      if(modifier === '>=' || modifier === 'greaterThanOrEqual' || modifier.toLowerCase() === 'gte') {
        obj['$gte'] = self.parseValue(field, modifier, val);
        return obj;
      }

      obj[modifier] = self.parseValue(field, modifier, val);
      return obj;
    }, {});
  }

  // <expression> ::= [value, ...], normalize array into tingo $in operator expression
  if (_.isArray(expression)) {
    return { $in: self.parseValue(field, '$in', expression) };
  }

  // <expression> ::= <value>, default equal expression
  return self.parseValue(field, undefined, expression);
};


/**
 * Parse Value
 *
 * <value> ::= RegExp | Number | String
 *           | [<value>, ...]
 *           | <plain object>
 *
 * @api private
 *
 * @param field
 * @param modifier
 * @param val
 * @returns {*}
 */
Query.prototype.parseValue = function parseValue(field, modifier, val) {
  "use strict";
  var self = this;

  if(_.isString(val)) {

    // If we can verify that the field is NOT a string type, translate
    // certain values into booleans, date or null.  Otherwise they'll be left
    // as strings.
    if (_.has(self.schema, field) && self.schema[field].type != 'string') {

      if(self.schema[field].type === 'integer'){
        return parseInt(val);
      }

      if(self.schema[field].type === 'float'){
        return parseFloat(val);
      }

      if(/^\d{4}-\d{2}-\d{2}T\d{2}\:\d{2}\:\d{2}\.\d{3}Z$/.test(val) && self.schema[field].type == 'date' || self.schema[field].type == 'datetime') {
        return new Date(val);
      }

      if(/^[1-9]\d{3}-\d{1,2}-\d{1,2}$/.test(val) && self.schema[field].type == 'date') {
        var parts = val.split('-');
        return new Date(parts[0], parts[1] - 1, parts[2]);
      }

      if (val === "false" && self.schema[field].type == 'boolean') {
        return false;
      }

      if (val === "true" && self.schema[field].type == 'boolean') {
        return true;
      }

    }

    if(modifier === '$ne') {
      return val;
    }

    return val;
  }

  // Array, RegExp, plain object, number
  return val;
};


/**
 * Parse Sort
 *
 * @param original
 * @returns {*}
 */
Query.prototype.parseSort = function parseSort(original) {
  "use strict";
  return _.reduce(original, function (sort, order, field) {
    // Normalize id, if used, into _id
    if (field === 'id') field = '_id';

    // Handle Sorting Order with binary or -1/1 values
    sort[field] = ([0, -1].indexOf(order) > -1) ? -1 : 1;

    return sort;
  }, {});
};

/**
 * Escape regex string
 */
Query.prototype.caseInsensitive = function(val) {
  if(!_.isString(val)) return val;
  return val.replace(/[-[\]{}()+?*.\/,\\^$|#]/g, "\\$&");
};
