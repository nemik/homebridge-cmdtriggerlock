"use strict";

var Service, Characteristic, HomebridgeAPI;
var exec = require('child_process').exec;
var inherits = require('util').inherits;


module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  homebridge.registerAccessory("homebridge-cmdtriggerlock", "CmdTriggerLock", CmdTriggerLock);
}

function keepIntInRange(num, min, max){
  const parsed = parseInt(num);
  return Math.min(Math.max(parsed, min), max);
}

function CmdTriggerLock(log, config) {
  this.log = log;
  this.timeout = -1;		
  this.restoredFromCacheState = false;
  this.remainingDelay = 0;
  
  // Setup Configuration
  //
  this.setupConfig(config);
  
  // Persistent Storage
  //
  this.cacheDirectory = HomebridgeAPI.user.persistPath();
  this.storage = require('node-persist');
  this.storage.initSync({dir:this.cacheDirectory, forgiveParseErrors: true});
  
  // Setup Services
  //
  this.createLockService();
  this.createAccessoryInformationService();
}

CmdTriggerLock.prototype.setupConfig = function(config) {
  this.name = config.name;
  this.onCmd = config.onCmd;
  this.offCmd = config.offCmd;
  this.stateful = config.stateful ? config.stateful : false;
  this.delay = config.delay ? parseInt(config.delay) : 1000;
  this.delayUnit = config.delayUnit ? config.delayUnit : "ms";
  this.interactiveDelay = false;
  if (config.interactiveDelaySettings !== undefined) {
    this.interactiveDelay = config.interactiveDelaySettings.interactiveDelay ? config.interactiveDelaySettings.interactiveDelay : false;
    this.interactiveDelayLabel = config.interactiveDelaySettings.interactiveDelayLabel ? config.interactiveDelaySettings.interactiveDelayLabel : "Delay";
    this.delayMin = config.interactiveDelaySettings.delayMin ? parseInt(config.interactiveDelaySettings.delayMin) : 100;
    this.delayMax = config.interactiveDelaySettings.delayMax ? parseInt(config.interactiveDelaySettings.delayMax) : 1000;
    this.delayStep = config.interactiveDelaySettings.delayStep ? parseInt(config.interactiveDelaySettings.delayStep) : 100;
  }

  if (this.delayMax <= this.delayMin) {
    throw new Error('Invalid configuration: delayMin must be smaller than delayMax');
  }

  if (this.delayStep >= (this.delayMax - this.delayMin)) {
    throw new Error('Invalid configuration: delayStep must be smaller than (delayMax - delayMin)');
  }

  this.delayFactor = 1;
  switch(this.delayUnit) {
    case "ms":
      this.delayFactor = 1;
      break;
    case "s":
      this.delayFactor = 1000;
      break;
    case "min":
      this.delayFactor = 60*1000;
      break;
    default:
      throw new Error('Invalid configuration: Unknown delayUnit (must be "ms", "s" or "min")');
      break;
  }
}

CmdTriggerLock.prototype.createLockService = function() {
  this.lockService = new Service.LockMechanism(this.name);

  this.is_on = false;

  this.lockService.getCharacteristic(Characteristic.LockCurrentState)
    .onGet(this.handleLockCurrentStateGet.bind(this));

  this.lockService.getCharacteristic(Characteristic.LockTargetState)
    .onGet(this.handleLockTargetStateGet.bind(this))
    .onSet(this.handleLockTargetStateSet.bind(this));

  if (this.interactiveDelay && !this.stateful) {
    const label = `${this.interactiveDelayLabel} (${this.delayUnit})`;
    const minVal = this.delayMin;
    const maxVal = this.delayMax;
    const step = this.delayStep;
    Characteristic.Delay = function() {
      const props = {
        format: Characteristic.Formats.UINT64,
        minValue: minVal,
        maxValue: maxVal,
        minStep: step,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
      };
      // var label = theLabel;
      Characteristic.call(this, label, '8728b5cc-5c49-4b44-bb25-a4c4d4715779', props);
      this.value = this.getDefaultValue();
    };
    inherits(Characteristic.Delay, Characteristic);
    Characteristic.Delay.UUID = '8728b5cc-5c49-4b44-bb25-a4c4d4715779';
    this.lockService.addCharacteristic(Characteristic.Delay);

    this.lockService.getCharacteristic(Characteristic.Delay)
      .on('set', this.lockSetDelay.bind(this));

    const cachedInteractiveDelay = this.storage.getItemSync(`${this.name} - interactiveDelay`);
    if(cachedInteractiveDelay === undefined) {
      const cid = keepIntInRange(this.delay, this.delayMin, this.delayMax);
      this.lockService.setCharacteristic(Characteristic.Delay, cid);
    } else {
      const cid = keepIntInRange(cachedInteractiveDelay, this.delayMin, this.delayMax);
      this.lockService.setCharacteristic(Characteristic.Delay, cid);
      this.delay = cid;
    }
  }

  if (this.stateful) {
    const cachedState = this.storage.getItemSync(this.name);
    if((cachedState === undefined) || (cachedState === false)) {
      if (cachedState === false) {
        this.restoredFromCacheState = true;
      }
      this.lockService.setCharacteristic(Characteristic.On, false);
    } else {
      this.restoredFromCacheState = true;
      this.lockService.setCharacteristic(Characteristic.On, true);
    }
  } else {
    const cachedStartTime = this.storage.getItemSync(`${this.name} - startTime`);
    if (cachedStartTime !== undefined) {
      const diffTime = Date.now() - cachedStartTime;
      this.log('diffTime: ' + diffTime/1000 + 's');
      if (diffTime > 0 && diffTime < this.delay*this.delayFactor) {
        this.remainingDelay = this.delay*this.delayFactor - diffTime;
        this.lockService.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.UNSECURED);
      }  
    } 
  }
}

CmdTriggerLock.prototype.createAccessoryInformationService = function() {
  this.accessoryInformationService =  new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Name, this.name)
    .setCharacteristic(Characteristic.Manufacturer, 'nemik')
    .setCharacteristic(Characteristic.Model, 'Command Trigger Lock');
}

CmdTriggerLock.prototype.getServices = function() {
  return [this.accessoryInformationService,  this.lockService];
}

CmdTriggerLock.prototype.handleLockCurrentStateGet = function() {
  this.log.debug('Triggered GET LockCurrentState');

  if(typeof this.is_on != "undefined" && this.is_on) {
    return Characteristic.LockCurrentState.UNSECURED;
  }
  return Characteristic.LockCurrentState.SECURED;
}


/**
 * Handle requests to get the current value of the "Lock Target State" characteristic
 */
CmdTriggerLock.prototype.handleLockTargetStateGet = function() {
  this.log.debug('Triggered GET LockTargetState');

  if(typeof this.is_on != "undefined" && this.is_on) {
    return Characteristic.LockTargetState.UNSECURED;
  }
  return Characteristic.LockTargetState.SECURED;
}


CmdTriggerLock.prototype.handleLockTargetStateSet = function(on) {
  this.log("Setting lock to " + on);

  if (this.stateful) {
	  this.storage.setItemSync(this.name, on);
  } else {
    if (on === Characteristic.LockTargetState.UNSECURED) {
      this.is_on = true;
      let delayMs = this.remainingDelay;
      if (delayMs <= 0) {
        delayMs = this.delay*this.delayFactor;
        this.storage.setItemSync(`${this.name} - startTime`, Date.now());
      }
      this.log("Delay in ms: " + delayMs);
      this.timeout = setTimeout(function() {
        this.log("Locking again after delay");
        this.lockService.setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
      }.bind(this), delayMs);
    } else {
      if (this.timeout !== -1) {
        this.log("clearing timeout");
        clearTimeout(this.timeout);
      }
    }
  }

  if (this.restoredFromCacheState) {
    this.log(`Restored lock state to ${on} after restart.`);
    this.restoredFromCacheState = false;
  } else if (this.remainingDelay > 0) {
    this.log(`Restored lock state to ${on} after restart, remaining delay ${this.remainingDelay}ms`);
    this.remainingDelay = 0;
  } else {
    if (on === Characteristic.LockTargetState.UNSECURED) {
      if (this.onCmd !== undefined) {
        this.log("Executing ON command: '" + this.onCmd + "'");
        exec(this.onCmd);
        this.is_on = true;
        this.lockService.setCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.UNSECURED);
      }
    } else {
      if (this.offCmd !== undefined) {
        this.log("Executing OFF command: '" + this.offCmd + "'");
        exec(this.offCmd);
        this.is_on = false;
        this.lockService.setCharacteristic(Characteristic.LockCurrentState, Characteristic.LockCurrentState.SECURED);
      }
    }
  }
}

CmdTriggerLock.prototype.lockSetDelay = function(delay, callback) {
  this.delay = delay;
  this.storage.setItemSync(`${this.name} - interactiveDelay`, delay);
  callback();
}
