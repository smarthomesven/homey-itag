'use strict';

const Homey = require('homey');

module.exports = class iTAGDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('iTAG driver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
  const advertisements = await this.homey.ble.discover();
  this.log('Discovered advertisements:', advertisements);
  const tags = advertisements.filter(advertisement => {
    return advertisement.localName === "iTAG            ";
  });

  const devices = tags.map(tag => {
    return {
      name: `iTAG ${tag.address}`,
      data: {
        id: tag.address,
      },
      store: {
        manufacturerData: tag.manufacturerData.toString('hex'),
        address: tag.address
      },
    };
  });

  this.log('iTAG devices available for pairing:', devices);
  return devices;
  }
  
  /**
    return [
      // Example device data, note that `store` is optional
      // {
      //   name: 'My Device',
      //   data: {
      //     id: 'my-device',
      //   },
      //   store: {
      //     address: '127.0.0.1',
      //   },
      // },
    ];
  }
    */

};
